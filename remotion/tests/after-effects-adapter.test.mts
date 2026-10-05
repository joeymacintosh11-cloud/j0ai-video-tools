import assert from "node:assert/strict";
import { execFile, spawn, type SpawnOptions } from "node:child_process";
import { chmodSync, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildAerenderArgs, parseAerenderProgressFrame } from "../adapters/after-effects/aerenderCommand.mts";
import {
  describeAerenderNotFound,
  discoverAerender,
  type DiscoveryFs,
} from "../adapters/after-effects/aerenderDiscovery.mts";
import { readAfterEffectsConfig } from "../adapters/after-effects/afterEffectsConfig.mts";
import {
  afterEffectsRenderEngine,
  createAfterEffectsRenderEngine,
  probeStreamTypesWithFfprobe,
} from "../adapters/after-effects/afterEffectsRenderEngine.mts";
import {
  REQUIRED_TEMPLATE_FILES,
  templateText,
  templateTextMarker,
} from "../adapters/after-effects/templateContract.mts";
import { renderEngines } from "../adapters/renderEngines.mts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import { TrackError } from "../core/domain/tracks/errors.ts";
import { renderPreset } from "../core/domain/video/renderPresets.ts";
import { buildTemplateData } from "../core/domain/video/templateData.ts";
import { makeCancelSignal } from "../core/ports/renderEngine.ts";
import { readDeliverySettings } from "../services/delivery/deliverySettings.ts";
import { readContentLibrary } from "../services/library/contentLibraryLog.ts";
import { renderTrackVideo } from "../services/render/renderTrackVideo.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { fingerprintInputs, readExportManifest } from "../services/tracks/exportManifest.ts";
import { PUBLIC_DIR, trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { fixture } from "./fixtures.mts";

/**
 * The After Effects adapter (adapters/after-effects/), with no After Effects:
 * discovery and config are exercised against fake filesystems and temp files,
 * and rendering runs tests/fake-aerender.mjs — a real executable, spawned
 * across the same process boundary as the real aerender would be.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_AERENDER = path.join(PROJECT_ROOT, "tests", "fake-aerender.mjs");
chmodSync(FAKE_AERENDER, 0o755);
const run = promisify(execFile);

const libraryDir = await mkdtemp(path.join(tmpdir(), "toshi-ae-library-"));
process.env.TOSHI_CONTENT_LIBRARY_DIR = libraryDir;
test.after(() => rm(libraryDir, { recursive: true, force: true }));

const trackErrorCode = (code: string, pattern: RegExp = /./) => (error: unknown) =>
  error instanceof TrackError && error.code === code && pattern.test(error.message);

/** Sets env vars for one test. */
const withEnv = (t: TestContext, values: Record<string, string | undefined>) => {
  for (const [key, value] of Object.entries(values)) {
    const previous = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
};

/**
 * A temp "template" folder: a placeholder project file (not a real .aep) and a
 * config pointing at it. The placeholder mentions the staged files the way a
 * real project's footage paths do, unless `references` says otherwise.
 */
const template = async (
  t: TestContext,
  config: Record<string, unknown> = {},
  references: readonly string[] = REQUIRED_TEMPLATE_FILES,
) => {
  const dir = await mkdtemp(path.join(tmpdir(), "toshi-ae-template-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, "ToshiVisualizer.aep");
  await writeFile(
    project,
    `placeholder project bytes, not an After Effects file\0${references.map((name) => `{"fullpath":"${dir}/${name}"}`).join("\0")}`,
  );
  const file = path.join(dir, "after-effects.local.json");
  await writeFile(file, JSON.stringify({ project: "ToshiVisualizer.aep", composition: "Toshi Visualizer", ...config }));
  return { dir, project, file, dataFile: path.join(dir, "toshi-render-data.json") };
};

/* ------------------------------------------------------------------ *
 * aerender discovery
 * ------------------------------------------------------------------ */

const fakeFs = (executables: readonly string[], dirs: Record<string, readonly string[]> = {}): DiscoveryFs => ({
  isExecutableFile: (file) => executables.includes(file),
  list: (dir) => dirs[dir] ?? [],
});

test("discovery prefers TOSHI_AERENDER_PATH, then the config, then PATH, then /Applications", () => {
  const env = { PATH: "/usr/local/bin:/opt/bin" };
  const everywhere = fakeFs(
    ["/env/aerender", "/config/aerender", "/opt/bin/aerender", "/Applications/Adobe After Effects 2025/aerender"],
    { "/Applications": ["Adobe After Effects 2025"] },
  );
  const discover = (overrides: Partial<Parameters<typeof discoverAerender>[0]>) =>
    discoverAerender({ env, configuredPath: null, platform: "darwin", fs: everywhere, ...overrides });

  assert.deepEqual(discover({ env: { ...env, TOSHI_AERENDER_PATH: "/env/aerender" }, configuredPath: "/config/aerender" }), {
    found: true,
    path: "/env/aerender",
    source: "env",
  });
  assert.deepEqual(discover({ configuredPath: "/config/aerender" }), { found: true, path: "/config/aerender", source: "config" });
  assert.deepEqual(discover({}), { found: true, path: "/opt/bin/aerender", source: "path" });
  assert.deepEqual(discover({ env: { PATH: "" } }), {
    found: true,
    path: "/Applications/Adobe After Effects 2025/aerender",
    source: "applications",
  });
});

test("/Applications installs are tried newest first, and only on macOS", () => {
  const installs = ["Adobe After Effects CC 2019", "Adobe After Effects 2025", "Adobe After Effects 2024", "Adobe Premiere Pro 2025"];
  const fs = fakeFs(
    ["/Applications/Adobe After Effects 2024/aerender", "/Applications/Adobe After Effects CC 2019/aerender"],
    { "/Applications": installs },
  );

  const mac = discoverAerender({ env: {}, configuredPath: null, platform: "darwin", fs });
  assert.deepEqual(mac, { found: true, path: "/Applications/Adobe After Effects 2024/aerender", source: "applications" });

  const linux = discoverAerender({ env: {}, configuredPath: null, platform: "linux", fs });
  assert.equal(linux.found, false);
});

test("an explicit path that is not executable is reported, never silently replaced", () => {
  const fs = fakeFs(["/opt/bin/aerender"]);
  const result = discoverAerender({
    env: { TOSHI_AERENDER_PATH: "/wrong/aerender", PATH: "/opt/bin" },
    configuredPath: null,
    platform: "darwin",
    fs,
  });
  assert.equal(result.found, false);
  assert.ok(!result.found);
  assert.match(describeAerenderNotFound(result), /TOSHI_AERENDER_PATH points to \/wrong\/aerender, which is not an executable file/);
});

test("when nothing is found, the message lists where to look and how to configure it", () => {
  const result = discoverAerender({ env: { PATH: "/usr/bin" }, configuredPath: null, platform: "darwin", fs: fakeFs([]) });
  assert.ok(!result.found);
  assert.deepEqual(result.tried, ["/usr/bin/aerender", "/Applications/Adobe After Effects */aerender"]);
  assert.match(describeAerenderNotFound(result), /aerender was not found \(searched PATH and \/Applications\)\. Install After Effects, or set TOSHI_AERENDER_PATH/);
});

/* ------------------------------------------------------------------ *
 * Configuration
 * ------------------------------------------------------------------ */

test("the config resolves paths relative to itself and fills in defaults", async (t) => {
  const { file, project, dataFile } = await template(t, { compositions: { "vertical-9x16": "Toshi 9x16" } });
  assert.deepEqual(readAfterEffectsConfig(file), {
    project,
    composition: "Toshi Visualizer",
    compositions: { "vertical-9x16": "Toshi 9x16" },
    outputModule: null,
    dataFile,
    aerenderPath: null,
    templateCheck: true,
    templatePreparation: "manual",
    applicationBundleId: "com.adobe.AfterEffects.application",
    preparationTimeoutMs: 120_000,
    workingDirectory: path.join(path.dirname(dataFile), ".toshi-ae-work"),
  });
});

test("a missing or wrong config is RENDERER_NOT_CONFIGURED, saying what to fix", async (t) => {
  const { dir, file } = await template(t);
  const missing = path.join(dir, "nope.json");
  assert.throws(() => readAfterEffectsConfig(missing), trackErrorCode("RENDERER_NOT_CONFIGURED", /needs a template.*"project".*"composition"/));

  const cases: [unknown, RegExp][] = [
    ["not json", /not valid JSON/],
    [{ composition: "C" }, /needs "project"/],
    [{ project: "x.mov", composition: "C" }, /must be an After Effects project/],
    [{ project: "missing.aep", composition: "C" }, /does not exist/],
    [{ project: "ToshiVisualizer.aep" }, /needs "composition"/],
    [{ project: "ToshiVisualizer.aep", composition: "C", compositions: { "8k": "C8" } }, /unknown format "8k"/],
    [{ project: "ToshiVisualizer.aep", composition: "C", outputModule: 3 }, /"outputModule" must be a non-empty string/],
  ];
  for (const [content, pattern] of cases) {
    await writeFile(file, typeof content === "string" ? content : JSON.stringify(content));
    assert.throws(() => readAfterEffectsConfig(file), trackErrorCode("RENDERER_NOT_CONFIGURED", pattern), String(pattern));
  }
});

/* ------------------------------------------------------------------ *
 * The aerender command line
 * ------------------------------------------------------------------ */

test("aerender arguments render exactly the track's frames of one composition", () => {
  assert.deepEqual(
    buildAerenderArgs({
      project: "/t/Toshi.aep",
      composition: "Toshi 9x16",
      output: "/out/render.mp4",
      durationInFrames: 300,
      outputModule: "H.264 - Match Render Settings - 15 Mbps",
    }),
    [
      "-project", "/t/Toshi.aep",
      "-comp", "Toshi 9x16",
      "-output", "/out/render.mp4",
      "-OMtemplate", "H.264 - Match Render Settings - 15 Mbps",
      "-s", "0",
      "-e", "299",
      "-v", "ERRORS_AND_PROGRESS",
      "-close", "DO_NOT_SAVE_CHANGES",
    ],
  );
  const noModule = buildAerenderArgs({ project: "/p.aep", composition: "C", output: "/o.mp4", durationInFrames: 1, outputModule: null });
  assert.equal(noModule.includes("-OMtemplate"), false);
  assert.deepEqual(noModule.slice(noModule.indexOf("-e"), noModule.indexOf("-e") + 2), ["-e", "0"]);
  assert.throws(() => buildAerenderArgs({ project: "/p.aep", composition: "C", output: "/o.mp4", durationInFrames: 0, outputModule: null }));
});

test("aerender progress lines yield their frame number; other lines do not", () => {
  assert.equal(parseAerenderProgressFrame("PROGRESS:  0:00:01:15 (46): 0 Seconds"), 46);
  assert.equal(parseAerenderProgressFrame("PROGRESS:  Total Time Elapsed: 1 Seconds"), null);
  assert.equal(parseAerenderProgressFrame("aerender version 24.0x1"), null);
});

/* ------------------------------------------------------------------ *
 * Registration and availability
 * ------------------------------------------------------------------ */

test("after-effects is registered, available exactly when aerender is found, and never resolves to Remotion", async (t) => {
  withEnv(t, { TOSHI_AERENDER_PATH: "/nonexistent/aerender" });
  assert.deepEqual(renderEngines.available, ["remotion"]);
  assert.throws(
    () => renderEngines.assertAvailable("after-effects"),
    trackErrorCode("RENDERER_UNAVAILABLE", /"after-effects" render engine is not available: TOSHI_AERENDER_PATH points to \/nonexistent\/aerender/),
  );

  process.env.TOSHI_AERENDER_PATH = FAKE_AERENDER;
  assert.deepEqual(renderEngines.available, ["remotion", "after-effects"]);
  const engine = await renderEngines.resolve("after-effects");
  assert.equal(engine, afterEffectsRenderEngine);
  assert.equal(engine.id, "after-effects");
});

/* ------------------------------------------------------------------ *
 * Rendering through the engine path, with the fake aerender
 * ------------------------------------------------------------------ */

const setup = async (
  t: TestContext,
  config: Record<string, unknown> = {},
  options: { references?: readonly string[]; probeStreamTypes?: (file: string) => Promise<string[]> } = {},
) => {
  const settings = await readDeliverySettings();
  if (settings.autoDeliver && settings.root !== null) {
    t.skip("auto-delivery is switched on in delivery.local.json");
    return null;
  }
  const f = await fixture(t);
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));
  const props = buildTrackProps({
    slug: f.slug,
    metadata: parseTrackMetadata(JSON.parse(await readFile(f.metadata, "utf8")), "fixture"),
    analysisAvailable: false,
  });
  const tpl = await template(t, config, options.references);
  const argsFile = path.join(tpl.dir, "argv.json");
  withEnv(t, { FAKE_AERENDER_ARGS_FILE: argsFile, FAKE_AERENDER_MODE: undefined });
  const logs: string[] = [];
  const engine = createAfterEffectsRenderEngine({
    readConfig: () => readAfterEffectsConfig(tpl.file),
    discover: () => ({ found: true, path: FAKE_AERENDER, source: "env" }),
    probeAudioDurationInSeconds: async () => 2,
    // The fake's default output is a text file; tests of the real ffprobe
    // check pass probeStreamTypesWithFfprobe and a real-MP4 fake mode.
    probeStreamTypes: options.probeStreamTypes ?? (async () => ["video", "audio"]),
  });
  return { f, props, tpl, argsFile, logs, engine };
};

const libraryFor = (slug: string) => readContentLibrary().records.filter((record) => record.track.slug === slug);

test("an After Effects render writes the sidecar, runs aerender, and publishes to its own folder", async (t) => {
  const ctx = await setup(t, { compositions: { "vertical-9x16": "Toshi 9x16" }, outputModule: "H.264" });
  if (!ctx) return;
  const progress: number[] = [];

  const result = await renderTrackVideo({
    engine: ctx.engine,
    slug: ctx.f.slug,
    props: ctx.props,
    presetId: "vertical-9x16",
    onProgress: (update) => progress.push(update.renderedFrames),
    onEngineLog: (message) => ctx.logs.push(message),
  });

  // 2 seconds at 30fps, rendered by the per-format composition.
  assert.deepEqual([result.durationInFrames, result.fps, result.width, result.height], [60, 30, 1080, 1920]);
  const argv: string[] = JSON.parse(await readFile(ctx.argsFile, "utf8"));
  assert.deepEqual(
    [argv[argv.indexOf("-project") + 1], argv[argv.indexOf("-comp") + 1], argv[argv.indexOf("-e") + 1], argv[argv.indexOf("-OMtemplate") + 1]],
    [ctx.tpl.project, "Toshi 9x16", "59", "H.264"],
  );
  assert.equal(progress.at(-1), 60);

  // The sidecar the project reads: the shared template-data contract, with
  // the track's assets staged at the fixed names the template imports.
  const staged = {
    cover: path.join(ctx.tpl.dir, "toshi-cover.png"),
    audio: path.join(ctx.tpl.dir, "toshi-audio.wav"),
    waveformAudio: path.join(ctx.tpl.dir, "toshi-waveform-audio.wav"),
    brandLogo: path.join(ctx.tpl.dir, "toshi-brand-logo.png"),
    brandBadge: path.join(ctx.tpl.dir, "toshi-brand-badge.png"),
  };
  assert.deepEqual(JSON.parse(await readFile(ctx.tpl.dataFile, "utf8")), {
    ...buildTemplateData({
      props: { ...ctx.props, presetId: "vertical-9x16" },
      preset: renderPreset("vertical-9x16"),
      durationInFrames: 60,
      resolveAsset: (relative) => path.join(PUBLIC_DIR, relative),
    }),
    assets: staged,
  });
  assert.equal(await readFile(staged.cover, "utf8"), "cover");
  assert.equal(await readFile(staged.audio, "utf8"), "audio");
  assert.equal(await readFile(staged.waveformAudio, "utf8"), "audio", "no analysis audio: the full audio stands in");
  assert.deepEqual(
    await readFile(staged.brandLogo),
    await readFile(path.join(PUBLIC_DIR, ctx.props.brandLogoSrc)),
  );

  // Published to out/<slug>/after-effects/, Remotion's path untouched.
  const ae = trackOutputLocation(ctx.f.slug, "vertical-9x16", "after-effects");
  assert.equal(result.outputLabel, `out/${ctx.f.slug}/after-effects/vertical-9x16.mp4`);
  assert.equal(await readFile(ae.path, "utf8"), "fake after effects video");
  await assert.rejects(readFile(trackOutputLocation(ctx.f.slug, "vertical-9x16").path));
  assert.equal(trackExportCoverage(ctx.f.slug).find((facts) => facts.presetId === "vertical-9x16")?.freshness, "missing");

  // Recorded as an After Effects export of this template — with no machine paths.
  const [record] = libraryFor(ctx.f.slug);
  assert.equal(record.template.renderer, "after-effects");
  assert.equal(record.template.composition, "Toshi 9x16");
  assert.match(record.template.visualizerVersion, /^aep-sha256:[0-9a-f]{64};prep:toshi-ae-prep-1;mode:manual$/);
  assert.equal(record.output.path, ae.label);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Its fingerprint is After Effects' and this template's, never Remotion's.
  const { manifest } = readExportManifest(ae.manifest, ctx.f.slug, "vertical-9x16");
  assert.ok(manifest);
  assert.notEqual(manifest.inputs.visualizer, fingerprintInputs(ctx.props, "vertical-9x16").visualizer);
  assert.equal(
    manifest.inputs.visualizer,
    fingerprintInputs(ctx.props, "vertical-9x16", PUBLIC_DIR, "after-effects").visualizer,
    "brand/renderer fingerprint is separate from template identity",
  );
  assert.match(manifest.inputs.template!, /^[a-f0-9]{64}$/);

  // Diagnostics name the binary, project, composition and output.
  const logText = ctx.logs.join("\n");
  for (const expected of [FAKE_AERENDER, ctx.tpl.project, `composition "Toshi 9x16"`, `staged in ${ctx.tpl.dir}`, "rendering to"]) {
    assert.ok(logText.includes(expected), `log mentions ${expected}`);
  }
});

test("editing the After Effects project changes the template version", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  await renderTrackVideo({ engine: ctx.engine, slug: ctx.f.slug, props: ctx.props, presetId: "square-1x1" });
  await writeFile(ctx.tpl.project, `${await readFile(ctx.tpl.project, "utf8")} — edited`);
  await renderTrackVideo({ engine: ctx.engine, slug: ctx.f.slug, props: ctx.props, presetId: "square-1x1" });

  const [first, second] = libraryFor(ctx.f.slug);
  assert.equal(first.template.composition, "Toshi Visualizer");
  assert.notEqual(first.template.visualizerVersion, second.template.visualizerVersion);
  assert.equal(second.exportKind, "reexport");
  assert.ok(second.replaces?.changed.includes("template_changed"));
});

for (const [mode, pattern] of [
  ["fail", /aerender exited with code 3 rendering "Toshi Visualizer"\. Last output: .*No comp was found/],
  ["mov", /aerender wrote after-effects-render\.mov, but Toshi exports are MP4\. Set "outputModule"/],
  ["silent", /aerender finished without writing after-effects-render\.mp4/],
] as const) {
  test(`aerender ${mode === "fail" ? "failing" : `leaving ${mode === "mov" ? "a .mov" : "nothing"}`} is a RENDER_FAILED; nothing is published or recorded`, async (t) => {
    const ctx = await setup(t);
    if (!ctx) return;
    process.env.FAKE_AERENDER_MODE = mode;

    await assert.rejects(
      renderTrackVideo({ engine: ctx.engine, slug: ctx.f.slug, props: ctx.props, presetId: "square-1x1" }),
      trackErrorCode("RENDER_FAILED", pattern),
    );
    // No fallback: neither engine's export exists, and nothing was recorded.
    for (const renderer of ["after-effects", "remotion"] as const) {
      await assert.rejects(readFile(trackOutputLocation(ctx.f.slug, "square-1x1", renderer).path));
    }
    assert.deepEqual(libraryFor(ctx.f.slug), []);
  });
}

test("cancelling stops aerender and publishes nothing", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  process.env.FAKE_AERENDER_MODE = "hang";
  const { cancelSignal, cancel } = makeCancelSignal();

  const rendering = renderTrackVideo({
    engine: ctx.engine,
    slug: ctx.f.slug,
    props: ctx.props,
    presetId: "square-1x1",
    cancelSignal,
    onProgress: () => cancel(),
  });
  await assert.rejects(rendering, /got cancelled/);
  await assert.rejects(readFile(trackOutputLocation(ctx.f.slug, "square-1x1", "after-effects").path));
  assert.deepEqual(libraryFor(ctx.f.slug), []);
});

test("the engine refuses to start without aerender or without a template", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;

  const noBinary = createAfterEffectsRenderEngine({
    readConfig: () => readAfterEffectsConfig(ctx.tpl.file),
    discover: () => ({ found: false, tried: ["/usr/bin/aerender"], problem: null }),
  });
  await assert.rejects(noBinary.open(), trackErrorCode("RENDERER_UNAVAILABLE", /aerender was not found/));

  const noTemplate = createAfterEffectsRenderEngine({
    readConfig: () => readAfterEffectsConfig(path.join(ctx.tpl.dir, "absent.json")),
    discover: () => ({ found: true, path: FAKE_AERENDER, source: "env" }),
  });
  await assert.rejects(noTemplate.open(), trackErrorCode("RENDERER_NOT_CONFIGURED", /needs a template/));
});

/* ------------------------------------------------------------------ *
 * The CLI, end to end, with the fake aerender
 * ------------------------------------------------------------------ */

const runScript = async (script: string, args: readonly string[], env: Record<string, string>) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [`scripts/${script}.mts`, ...args], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, ...env },
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, output: failed.stdout + failed.stderr };
  }
};
const cli = (args: readonly string[], env: Record<string, string>) => runScript("render-track", args, env);

test("render-track --engine after-effects: unavailable, then unconfigured, then a real run through aerender", async (t) => {
  const f = await fixture(t);
  await writeFile(f.cover, "cover");
  await run("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=1", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le", "-y", f.beat]);
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));
  t.after(() => rm(f.analysis, { force: true }));
  const tpl = await template(t);

  const unavailable = await cli([f.slug, "--engine", "after-effects"], { TOSHI_AERENDER_PATH: "/nonexistent/aerender" });
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.output, /"after-effects" render engine is not available: TOSHI_AERENDER_PATH points to/);
  assert.doesNotMatch(unavailable.output, /Preparing track|Bundling Remotion/);

  const unconfigured = await cli([f.slug, "--engine", "after-effects", "--preset", "square-1x1"], {
    TOSHI_AERENDER_PATH: FAKE_AERENDER,
    TOSHI_AE_CONFIG: path.join(tpl.dir, "absent.json"),
  });
  assert.equal(unconfigured.code, 1);
  assert.match(unconfigured.output, /After Effects rendering needs a template/);
  assert.doesNotMatch(unconfigured.output, /Bundling Remotion/);

  const rendered = await cli([f.slug, "--engine", "after-effects", "--preset", "square-1x1"], {
    TOSHI_AERENDER_PATH: FAKE_AERENDER,
    TOSHI_AE_CONFIG: tpl.file,
    FAKE_AERENDER_MODE: "mp4",
  });
  assert.equal(rendered.code, 0, rendered.output);
  for (const expected of [
    "Render engine: after-effects",
    "Opening the after-effects render engine",
    "Resolving the after-effects template",
    `aerender ${FAKE_AERENDER} (found via env)`,
    `project ${tpl.project}`,
    `composition "Toshi Visualizer", 30 frames @ 30fps`,
    `out/${f.slug}/after-effects/square-1x1.mp4`,
  ]) {
    assert.ok(rendered.output.includes(expected), `output mentions ${expected}\n${rendered.output}`);
  }
  assert.doesNotMatch(rendered.output, /Bundling Remotion/);
  assert.deepEqual(
    (await probeStreamTypesWithFfprobe(trackOutputLocation(f.slug, "square-1x1", "after-effects").path)).sort(),
    ["audio", "video"],
  );
});

test("planning commands refuse an explicit engine that conflicts with saved Remotion intent", async () => {
  for (const [script, args] of [
    ["render-missing", ["--all-tracks", "--dry-run"]],
    ["content-package", ["ghetto-geek"]],
    ["content-package-batch", ["--track", "ghetto-geek"]],
  ] as const) {
    const result = await runScript(script, [...args, "--engine", "after-effects"], { TOSHI_AERENDER_PATH: FAKE_AERENDER });
    assert.equal(result.code, 1, script);
    assert.match(result.output, new RegExp(`${script} cannot override preferred renderer remotion with after-effects`), script);
    assert.match(result.output, /Change the track's saved preference first/, script);
  }
});

/* ------------------------------------------------------------------ *
 * Catching a template that would render black and silent
 * ------------------------------------------------------------------ */

test("a project that does not use the staged files stops before aerender runs, with the files staged to import", async (t) => {
  // The project from the first real render: right composition, no layers using Toshi's files.
  const ctx = await setup(t, {}, { references: [] });
  if (!ctx) return;

  await assert.rejects(
    renderTrackVideo({ engine: ctx.engine, slug: ctx.f.slug, props: ctx.props, presetId: "youtube-16x9" }),
    trackErrorCode(
      "RENDERER_NOT_CONFIGURED",
      /does not use toshi-cover\.png, toshi-audio\.wav, so it would render without the track's cover; or audio\. The files are staged in .*create-toshi-template\.jsx/,
    ),
  );
  await assert.rejects(readFile(ctx.argsFile), "aerender never ran");
  for (const name of ["toshi-render-data.json", "toshi-cover.png", "toshi-audio.wav", "toshi-brand-logo.png"]) {
    await readFile(path.join(ctx.tpl.dir, name));
  }
  assert.deepEqual(libraryFor(ctx.f.slug), []);
});

test("templateCheck: false skips the reference check for a template that does not need the files", async (t) => {
  const ctx = await setup(t, { templateCheck: false }, { references: [] });
  if (!ctx) return;
  const result = await renderTrackVideo({ engine: ctx.engine, slug: ctx.f.slug, props: ctx.props, presetId: "square-1x1" });
  assert.equal(result.outputLabel, `out/${ctx.f.slug}/after-effects/square-1x1.mp4`);
});

test("a rendered video without audio is a failed render, never an export (real ffprobe)", async (t) => {
  const ctx = await setup(t, {}, { probeStreamTypes: probeStreamTypesWithFfprobe });
  if (!ctx) return;
  process.env.FAKE_AERENDER_MODE = "mp4-silent";

  await assert.rejects(
    renderTrackVideo({ engine: ctx.engine, slug: ctx.f.slug, props: ctx.props, presetId: "youtube-16x9" }),
    trackErrorCode("RENDER_FAILED", /aerender's video has no audio stream\. Check that composition "Toshi Visualizer" has a toshi-audio\.wav layer .* Audio Output is On or Auto/),
  );
  await assert.rejects(readFile(trackOutputLocation(ctx.f.slug, "youtube-16x9", "after-effects").path));
  assert.deepEqual(libraryFor(ctx.f.slug), []);
});

test("a rendered video with picture and sound is published (real ffprobe)", async (t) => {
  const ctx = await setup(t, {}, { probeStreamTypes: probeStreamTypesWithFfprobe });
  if (!ctx) return;
  process.env.FAKE_AERENDER_MODE = "mp4";

  await renderTrackVideo({ engine: ctx.engine, slug: ctx.f.slug, props: ctx.props, presetId: "youtube-16x9" });
  const output = trackOutputLocation(ctx.f.slug, "youtube-16x9", "after-effects").path;
  assert.deepEqual((await probeStreamTypesWithFfprobe(output)).sort(), ["audio", "video"]);
  assert.equal(libraryFor(ctx.f.slug).length, 1);
});

/* ------------------------------------------------------------------ *
 * The track's text, written into the template when it is built
 * ------------------------------------------------------------------ */

/** The fixture track's text marker, as create-toshi-template.jsx records it. */
const FIXTURE_MARKER = templateTextMarker(templateText({ title: "Fixture", artist: "Toshi", key: "F Minor", bpm: 100 }));

test("the staged sidecar holds the track text the template builder writes in", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  await renderTrackVideo({
    engine: ctx.engine,
    slug: ctx.f.slug,
    props: ctx.props,
    presetId: "youtube-16x9",
    onEngineLog: (message) => ctx.logs.push(message),
  });

  const written = JSON.parse(await readFile(ctx.tpl.dataFile, "utf8"));
  assert.deepEqual(templateText(written.track), { Title: "Fixture", Artist: "Toshi", "Key BPM": "F Minor · 100 BPM" });
  assert.ok(
    ctx.logs.includes(
      `After Effects: this track's text: Title "Fixture", Artist "Toshi", Key BPM "F Minor · 100 BPM" (${FIXTURE_MARKER}).`,
    ),
    ctx.logs.join("\n"),
  );
});

test("a template built for another track stops before aerender runs, with this track staged to rebuild it", async (t) => {
  const ctx = await setup(t, {}, { references: [...REQUIRED_TEMPLATE_FILES, "toshi-text-0badc0de"] });
  if (!ctx) return;
  await assert.rejects(
    renderTrackVideo({ engine: ctx.engine, slug: ctx.f.slug, props: ctx.props, presetId: "youtube-16x9" }),
    trackErrorCode(
      "RENDERER_NOT_CONFIGURED",
      new RegExp(
        `was built with another track's title, artist and key: .*does not match this track \\(${FIXTURE_MARKER}\\)\\. ` +
          `This track's data is now staged in .*create-toshi-template\\.jsx`,
      ),
    ),
  );
  await assert.rejects(readFile(ctx.argsFile), "aerender never ran");
  assert.equal(JSON.parse(await readFile(ctx.tpl.dataFile, "utf8")).track.title, "Fixture", "staged for the rebuild");
  assert.deepEqual(libraryFor(ctx.f.slug), []);

  // templateCheck: false is the way out for a template whose text comes from elsewhere.
  const unchecked = await setup(t, { templateCheck: false }, { references: [...REQUIRED_TEMPLATE_FILES, "toshi-text-0badc0de"] });
  if (!unchecked) return;
  await renderTrackVideo({ engine: unchecked.engine, slug: unchecked.f.slug, props: unchecked.props, presetId: "youtube-16x9" });
});

test("a template built for this track renders and says so", async (t) => {
  const ctx = await setup(t, {}, { references: [...REQUIRED_TEMPLATE_FILES, FIXTURE_MARKER] });
  if (!ctx) return;
  await renderTrackVideo({
    engine: ctx.engine,
    slug: ctx.f.slug,
    props: ctx.props,
    presetId: "youtube-16x9",
    onEngineLog: (message) => ctx.logs.push(message),
  });
  assert.ok(ctx.logs.includes("After Effects: template text matches this track."), ctx.logs.join("\n"));
  assert.ok(!ctx.logs.some((message) => message.includes("Toshi text marker")));
});

test("a template without the composition name or a waveform effect renders, with warnings in the log", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  await renderTrackVideo({
    engine: ctx.engine,
    slug: ctx.f.slug,
    props: ctx.props,
    presetId: "square-1x1",
    onEngineLog: (message) => ctx.logs.push(message),
  });
  const warnings = ctx.logs.filter((message) => message.includes("warning:"));
  assert.equal(warnings.length, 3);
  assert.match(warnings[0], /carries no Toshi text marker, so its title, artist and key may not be this track's/);
  assert.match(warnings[1], /composition "Toshi Visualizer" was not found in the project file/);
  assert.match(warnings[2], /no Audio Waveform effect/);

  // A project with all three draws no warnings.
  const quiet = await setup(t, {}, { references: [...REQUIRED_TEMPLATE_FILES, FIXTURE_MARKER, "Toshi Visualizer", "ADBE AudWave"] });
  if (!quiet) return;
  await renderTrackVideo({
    engine: quiet.engine,
    slug: quiet.f.slug,
    props: quiet.props,
    presetId: "square-1x1",
    onEngineLog: (message) => quiet.logs.push(message),
  });
  assert.deepEqual(quiet.logs.filter((message) => message.includes("warning:")), []);
});


test("overlapping AE sessions cannot overwrite staged footage; a closed session permits the next", async (t) => {
  const f = await setup(t);
  if (!f) return;
  const first = await f.engine.open();
  const second = await f.engine.open();
  try {
    await first.resolve(f.props);
    await assert.rejects(second.resolve(f.props), trackErrorCode("RENDER_TARGET_LOCKED", /AE renders run serially/));
    await first.close();
    await second.resolve(f.props);
  } finally {
    await first.close();
    await second.close();
  }
});


test("cancellation waits for delayed aerender shutdown before releasing staging ownership", async (t) => {
  const ctx = await setup(t); if (!ctx) return;
  withEnv(t,{FAKE_AERENDER_MODE:"hang-delayed"});
  const lock = path.join(ctx.tpl.dir,".toshi-ae-render.lock");
  let closed = false;
  const engine = createAfterEffectsRenderEngine({readConfig:()=>readAfterEffectsConfig(ctx.tpl.file),
    discover:()=>({found:true,path:FAKE_AERENDER,source:"env"}),
    probeAudioDurationInSeconds:async()=>1,probeStreamTypes:async()=>["video","audio"],
    spawn: ((command:string,args:readonly string[],options:SpawnOptions)=> {
      const child=spawn(command,args,options); child.once("close",()=>{assert.ok(existsSync(lock),"ownership must outlive child");closed=true;});return child;
    }) as typeof spawn,
  });
  const cancel=makeCancelSignal();
  await assert.rejects(renderTrackVideo({engine,slug:ctx.f.slug,props:ctx.props,cancelSignal:cancel.cancelSignal,onProgress:()=>cancel.cancel()}),/got cancelled/);
  assert.equal(closed,true); assert.equal(existsSync(lock),false);
  await assert.rejects(readFile(trackOutputLocation(ctx.f.slug,"youtube-16x9","after-effects").path));
  assert.deepEqual(libraryFor(ctx.f.slug),[]);
});
