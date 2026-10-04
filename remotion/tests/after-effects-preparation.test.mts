import assert from "node:assert/strict";
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { fixture } from "./fixtures.mts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import { renderTrackVideo } from "../services/render/renderTrackVideo.ts";
import { PUBLIC_DIR, trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { readContentLibrary } from "../services/library/contentLibraryLog.ts";
import { readExportManifest } from "../services/tracks/exportManifest.ts";
import type { RenderEngine } from "../core/ports/renderEngine.ts";
import { readAfterEffectsConfig } from "../adapters/after-effects/afterEffectsConfig.mts";
import { createAfterEffectsRenderEngine } from "../adapters/after-effects/afterEffectsRenderEngine.mts";
import { PreparationError, PREPARATION_VERSION, runAfterEffectsPreparation } from "../adapters/after-effects/afterEffectsScripting.mts";
import { hashProject, prepareAfterEffectsTemplate, type PrepareTemplateInput } from "../adapters/after-effects/templatePreparation.mts";
import { templateText, templateTextMarker } from "../adapters/after-effects/templateContract.mts";
import { makeCancelSignal } from "../core/ports/renderEngine.ts";

const FAKE = fileURLToPath(new URL("./fake-osascript.mjs", import.meta.url));
const AERENDER = fileURLToPath(new URL("./fake-aerender.mjs", import.meta.url));
await chmod(FAKE, 0o755);
const libraryDir = await mkdtemp(path.join(tmpdir(), "toshi-auto-library-"));
process.env.TOSHI_CONTENT_LIBRARY_DIR = libraryDir;
test.after(() => rm(libraryDir, { recursive: true, force: true }));
const setup = async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), "toshi-auto-prep-"));
  const bundle = `test.toshi.${path.basename(dir)}`;
  const guiDir = path.join(tmpdir(), `toshi-ae-automation-${hashProject(bundle).slice(0, 16)}`);
  t.after(async () => { await rm(dir, { recursive: true, force: true }); await rm(guiDir, { recursive: true, force: true }); });
  const project = path.join(dir, "base.aep");
  const baseBytes = Buffer.from("RIFX original template never modified");
  await writeFile(project, baseBytes);
  const file = path.join(dir, "config.json");
  await writeFile(file, JSON.stringify({ project, composition: "Toshi Visualizer", templatePreparation: "auto", applicationBundleId: bundle, preparationTimeoutMs: 1000 }));
  const config = readAfterEffectsConfig(file);
  const calls = path.join(dir, "calls.jsonl");
  const logs: string[] = [];
  const text = templateText({ title: "Track A", artist: "Toshi", key: "C", bpm: 120 });
  const input = { config, baseBytes, composition: config.composition, text, marker: templateTextMarker(text), trackIdentity: "track-a",
    assets: { "toshi-cover": path.join(dir, "toshi-cover.png"), "toshi-audio": path.join(dir, "toshi-audio.wav") }, log: (line: string) => logs.push(line) };
  let mode = "ok";
  const spawn = ((_command: string, args: readonly string[], options: SpawnOptions) => nodeSpawn(FAKE, args, {
    ...options, env: { ...process.env, FAKE_PREP_MODE: mode, FAKE_PREP_CALLS: calls },
  })) as typeof nodeSpawn;
  const run: typeof runAfterEffectsPreparation = (options) => runAfterEffectsPreparation({ ...options, spawn });
  const prepare = (changes: Partial<PrepareTemplateInput> = {}, prepVersion = PREPARATION_VERSION) =>
    prepareAfterEffectsTemplate({ ...input, ...changes }, { run, prepVersion });
  return { dir, guiDir, project, file, config, baseBytes, input, logs, calls, prepare, run, setMode: (next: string) => { mode = next; } };
};

test("auto config is validated and manual remains the default", async (t) => {
  const c = await setup(t);
  assert.equal(c.config.templatePreparation, "auto");
  for (const settings of [{ templatePreparation: "fallback" }, { applicationBundleId: 'bad"id' }, { preparationTimeoutMs: -1 }, { workingDirectory: "" }]) {
    await writeFile(c.file, JSON.stringify({ project: c.project, composition: "C", ...settings }));
    assert.throws(() => readAfterEffectsConfig(c.file), /must be/);
  }
  await writeFile(c.file, JSON.stringify({ project: c.project, composition: "C" }));
  assert.equal(readAfterEffectsConfig(c.file).templatePreparation, "manual");
});

test("one-track prep, cache reuse skips osascript, provenance binds saved copy and base remains unchanged", async (t) => {
  const c = await setup(t);
  const first = await c.prepare();
  assert.equal(await c.prepare(), first);
  assert.equal((await readFile(c.calls, "utf8")).trim().split("\n").length, 1);
  assert.deepEqual(await readFile(c.project), c.baseBytes);
  assert.ok(c.logs.some((line) => line.includes("Reusing prepared")));
  assert.equal((await readdir(c.config.workingDirectory)).some((name) => name.startsWith("run-")), false);
});

test("two AE tracks sequentially get different prepared copies and current markers", async (t) => {
  const c = await setup(t);
  const a = await c.prepare();
  const text = templateText({ title: "Track B", artist: "Another" });
  const b = await c.prepare({ text, marker: templateTextMarker(text), trackIdentity: "track-b" });
  assert.notEqual(a, b);
  assert.ok((await readFile(b, "utf8")).includes(templateTextMarker(text)));
  assert.equal((await readFile(c.calls, "utf8")).trim().split("\n").length, 2);
});

test("base hash and preparation version changes invalidate the cache", async (t) => {
  const c = await setup(t);
  const first = await c.prepare();
  const changed = Buffer.from("RIFX edited base project");
  await writeFile(c.project, changed);
  const second = await c.prepare({ baseBytes: changed });
  const third = await c.prepare({ baseBytes: changed }, "toshi-ae-prep-next");
  assert.equal(new Set([first, second, third]).size, 3);
});

test("corrupt copy, wrong-track copy and corrupt provenance are cache misses", async (t) => {
  const c = await setup(t);
  const project = await c.prepare();
  await writeFile(project, "broken");
  await c.prepare();
  const bytes = Buffer.from((await readFile(project, "utf8")).replace(c.input.marker, "toshi-text-deadbeef"));
  await writeFile(project, bytes);
  const meta = JSON.parse(await readFile(`${project}.json`, "utf8"));
  await writeFile(`${project}.json`, JSON.stringify({ ...meta, projectHash: hashProject(bytes) }));
  await c.prepare();
  await writeFile(`${project}.json`, "malformed");
  await c.prepare();
  assert.equal((await readFile(c.calls, "utf8")).trim().split("\n").length, 4);
});

for (const mode of ["wrong-track", "missing-project", "save-fail"]) {
  test(`${mode}: invalid/failed preparation is rejected and temporary files are cleaned`, async (t) => {
    const c = await setup(t); c.setMode(mode);
    await assert.rejects(c.prepare(), PreparationError);
    assert.deepEqual(await readdir(c.config.workingDirectory), []);
    assert.deepEqual(await readFile(c.project), c.baseBytes);
    c.setMode("ok"); await c.prepare(); // Terminal failure releases GUI lock.
  });
}

for (const mode of ["wrong-token", "wrong-status-path", "missing-status", "malformed", "launch-fail", "hang"]) {
  test(`${mode}: unconfirmed JSX fails closed and preserves recovery evidence`, async (t) => {
    const c = await setup(t); c.setMode(mode);
    await assert.rejects(c.prepare({ config: { ...c.config, preparationTimeoutMs: 100 } }),
      (error: unknown) => error instanceof PreparationError && error.uncertain);
    assert.ok((await readdir(c.config.workingDirectory)).some((name) => name.startsWith("run-")));
    assert.deepEqual(await readFile(c.project), c.baseBytes);
    assert.ok(c.logs.some((line) => line.includes("retaining staging/GUI locks")));
    await assert.rejects(c.prepare(), /locked/);
  });
}

test("stale status in an unrelated run is ignored", async (t) => {
  const c = await setup(t);
  await mkdir(c.config.workingDirectory);
  await writeFile(path.join(c.config.workingDirectory, "status-old.json"), JSON.stringify({ success: true, token: "old" }));
  c.setMode("missing-status");
  await assert.rejects(c.prepare(), /Missing or malformed status/);
});

test("launch ENOENT is a confirmed non-start and cleans job/partial files", async (t) => {
  const c = await setup(t);
  const spawn = ((_command: string, args: readonly string[], options: SpawnOptions) => nodeSpawn(path.join(c.dir, "no-osascript"), args, options)) as typeof nodeSpawn;
  await assert.rejects(prepareAfterEffectsTemplate(c.input, {
    run: (options) => runAfterEffectsPreparation({ ...options, spawn }),
  }), (error: unknown) => error instanceof PreparationError && !error.uncertain);
  assert.deepEqual(await readdir(c.config.workingDirectory), []);
});

test("cancellation stops the sender before failing closed; pre-launch cancel leaves no partials", async (t) => {
  const c = await setup(t); c.setMode("hang");
  const cancel = makeCancelSignal();
  const task = c.prepare({ cancelSignal: cancel.cancelSignal });
  const timer = setTimeout(cancel.cancel, 150);
  try { await assert.rejects(task, (error: unknown) => error instanceof PreparationError && error.uncertain); }
  finally { clearTimeout(timer); }
  const d = await setup(t); const already = makeCancelSignal(); already.cancel();
  await assert.rejects(prepareAfterEffectsTemplate({ ...d.input, cancelSignal: already.cancelSignal }, { run: d.run }), /cancelled before launch/);
  assert.deepEqual(await readdir(d.config.workingDirectory), []);
});

test("GUI preparation is serialized even with different staging folders", async (t) => {
  const c = await setup(t); c.setMode("hang");
  const first = c.prepare();
  // Wait for the fake to enter the protected region, without racing its startup.
  for (let n = 0; n < 100; n++) {
    if (await readFile(c.calls).then(() => true, () => false)) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  const other = { ...c.config, workingDirectory: path.join(c.dir, "other-cache"), dataFile: path.join(c.dir, "different.json") };
  await assert.rejects(c.prepare({ config: other }), /locked/);
  await assert.rejects(first, PreparationError);
  assert.equal((await readFile(c.calls, "utf8")).trim().split("\n").length, 1);
});

test("cancel with matching terminal status cleans safely; no sender is left running", async (t) => {
  const c = await setup(t); c.setMode("cancel-status");
  const cancel = makeCancelSignal();
  const task = c.prepare({ cancelSignal: cancel.cancelSignal });
  // The fake writes the call file immediately before installing its handler.
  for (let n = 0; n < 100; n++) {
    if (await readFile(c.calls).then(() => true, () => false)) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  cancel.cancel();
  await assert.rejects(task, (error: unknown) => error instanceof PreparationError && !error.uncertain);
  assert.deepEqual(await readdir(c.config.workingDirectory), []);
  c.setMode("ok"); await c.prepare();
});

test("the GUI lock excludes a second Node process", async (t) => {
  const c = await setup(t); c.setMode("hang");
  const first = c.prepare();
  for (let n = 0; n < 100; n++) {
    if (await readFile(c.calls).then(() => true, () => false)) break;
    await new Promise((done) => setTimeout(done, 10));
  }
  const module = new URL("../adapters/after-effects/stagingLock.mts", import.meta.url).href;
  const child = nodeSpawn(process.execPath, ["--input-type=module", "-e",
    `import { acquireAfterEffectsStagingLock } from ${JSON.stringify(module)};
     try { acquireAfterEffectsStagingLock(${JSON.stringify(path.join(c.guiDir, "automation.json"))}); process.exit(2); }
     catch (error) { process.exit(error.code === "RENDER_TARGET_LOCKED" ? 0 : 3); }`]);
  const code = await new Promise<number | null>((done) => child.once("close", done));
  assert.equal(code, 0);
  await assert.rejects(first, PreparationError);
});

test("AE engine uses prepared projects sequentially, retains renderer identity and reports prep version", async (t) => {
  const c = await setup(t);
  const publicDir = path.join(c.dir, "public"); await mkdir(publicDir);
  for (const name of ["cover.png", "audio.wav", "logo.png", "badge.png"]) await writeFile(path.join(publicDir, name), name);
  const props = { title: "A", artist: "Toshi", musicalKey: "C", bpm: 120,
    coverSrc: "cover.png", audioSrc: "audio.wav", brandLogoSrc: "logo.png", brandBadgeSrc: "badge.png" };
  const projects: string[] = [];
  const engine = createAfterEffectsRenderEngine({ readConfig: () => c.config, publicDir,
    discover: () => ({ found: true, path: AERENDER, source: "env" }), probeAudioDurationInSeconds: async () => 1,
    probeStreamTypes: async () => ["video", "audio"],
    prepareTemplate: (input) => prepareAfterEffectsTemplate(input, { run: c.run }),
    spawn: ((command: string, args: readonly string[], options: SpawnOptions) => { projects.push(args[1]); return nodeSpawn(command, args, options); }) as typeof nodeSpawn,
  });
  for (const title of ["A", "B", "A"]) {
    const session = await engine.open({ log: c.input.log });
    try {
      const resolved = await session.resolve({ ...props, title });
      assert.ok(resolved.template?.version.includes(PREPARATION_VERSION));
      await session.render({ outputPath: path.join(c.dir, `${title}.mp4`) });
    } finally { await session.close(); }
  }
  assert.notEqual(projects[0], projects[1]); assert.equal(projects[0], projects[2]);
  assert.equal((await readFile(c.calls, "utf8")).trim().split("\n").length, 2);
  assert.deepEqual(await readFile(c.project), c.baseBytes);
});

test("headless JSX has no interactive calls and closes before atomic terminal status", async () => {
  const source = await readFile(new URL("../adapters/after-effects/template/prepare-toshi-template.jsx", import.meta.url), "utf8");
  new vm.Script(source); // ES syntax check; no Adobe execution.
  assert.doesNotMatch(source, /\b(?:alert|prompt)\s*\(|Folder\.selectDialog\s*\(/);
  assert.ok(source.indexOf("app.project.close(") < source.indexOf("status.rename("));
  assert.match(source, /job\.text\[names\[n\]\]/); // Consumes shared Node text rules.
  assert.match(source, /GUI_PROJECT_BUSY/);
});

test("mixed Remotion + automatic AE batch publishes engine-specific exports through the service", async (t) => {
  const c = await setup(t);
  const remotion: RenderEngine = { id: "remotion", open: async () => ({ assetRoot: PUBLIC_DIR,
    resolve: async () => ({ durationInFrames: 30, fps: 30, width: 1920, height: 1080 }),
    render: async ({ outputPath }) => { await writeFile(outputPath, "fake remotion video"); }, close: async () => {},
  }) };
  const ae = createAfterEffectsRenderEngine({ readConfig: () => c.config,
    discover: () => ({ found: true, path: AERENDER, source: "env" }),
    probeAudioDurationInSeconds: async () => 1, probeStreamTypes: async () => ["video", "audio"],
    prepareTemplate: (input) => prepareAfterEffectsTemplate(input, { run: c.run }),
  });
  for (const [n, engine] of [remotion, ae, ae].entries()) {
    const f = await fixture(t, { title: `Batch track ${n}`, renderer: engine.id });
    await writeFile(f.cover, "synthetic cover"); await writeFile(f.beat, "synthetic audio");
    t.after(() => rm(f.outputDir, { recursive: true, force: true }));
    const metadata = parseTrackMetadata(JSON.parse(await readFile(f.metadata, "utf8")), "fixture");
    const props = buildTrackProps({ slug: f.slug, metadata, analysisAvailable: false });
    const result = await renderTrackVideo({ engine, slug: f.slug, props, onEngineLog: c.input.log });
    const output = trackOutputLocation(f.slug, "youtube-16x9", engine.id);
    assert.equal(result.outputPath, output.path);
    assert.ok((await readFile(output.path)).length > 0);
    const manifest = readExportManifest(output.manifest, f.slug, "youtube-16x9").manifest;
    assert.ok(manifest);
    assert.equal(readContentLibrary().records.find((record) => record.track.slug === f.slug)?.template.renderer, engine.id);
    const other = trackOutputLocation(f.slug, "youtube-16x9", engine.id === "remotion" ? "after-effects" : "remotion");
    await assert.rejects(readFile(other.path), { code: "ENOENT" });
  }
  assert.equal((await readFile(c.calls, "utf8")).trim().split("\n").length, 2);
  assert.deepEqual(await readFile(c.project), c.baseBytes);
});

test("engine close after unconfirmed prep retains staging lock and never starts aerender", async (t) => {
  const c = await setup(t); c.setMode("missing-status");
  let aerenderCalls = 0;
  const dir = path.join(c.dir, "assets"); await mkdir(dir);
  for (const name of ["cover.png", "audio.wav", "logo.png", "badge.png"]) await writeFile(path.join(dir, name), "synthetic");
  const engine = createAfterEffectsRenderEngine({ readConfig: () => ({ ...c.config, preparationTimeoutMs: 100 }), publicDir: dir,
    discover: () => ({ found: true, path: AERENDER, source: "env" }), probeAudioDurationInSeconds: async () => 1,
    prepareTemplate: (input) => prepareAfterEffectsTemplate(input, { run: c.run }),
    spawn: ((command: string, args: readonly string[], options: SpawnOptions) => {
      aerenderCalls++; return nodeSpawn(command, args, options);
    }) as typeof nodeSpawn,
  });
  const props = { title: "A", artist: "Toshi", musicalKey: "C", bpm: 120,
    coverSrc: "cover.png", audioSrc: "audio.wav", brandLogoSrc: "logo.png", brandBadgeSrc: "badge.png" };
  const first = await engine.open();
  await assert.rejects(first.resolve(props), PreparationError);
  await first.close();
  const second = await engine.open();
  await assert.rejects(second.resolve(props), /locked/);
  await second.close();
  assert.equal(aerenderCalls, 0);
  assert.deepEqual(await readFile(c.project), c.baseBytes);
});
