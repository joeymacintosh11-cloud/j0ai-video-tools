import assert from "node:assert/strict";
import { chmodSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
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
} from "../adapters/after-effects/afterEffectsRenderEngine.mts";
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

/** A temp "template" folder: a placeholder project file (not a real .aep) and a config pointing at it. */
const template = async (t: TestContext, config: Record<string, unknown> = {}) => {
  const dir = await mkdtemp(path.join(tmpdir(), "toshi-ae-template-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = path.join(dir, "ToshiVisualizer.aep");
  await writeFile(project, "placeholder project bytes — not an After Effects file");
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

const setup = async (t: TestContext, config: Record<string, unknown> = {}) => {
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
  const tpl = await template(t, config);
  const argsFile = path.join(tpl.dir, "argv.json");
  withEnv(t, { FAKE_AERENDER_ARGS_FILE: argsFile, FAKE_AERENDER_MODE: undefined });
  const logs: string[] = [];
  const engine = createAfterEffectsRenderEngine({
    readConfig: () => readAfterEffectsConfig(tpl.file),
    discover: () => ({ found: true, path: FAKE_AERENDER, source: "env" }),
    probeAudioDurationInSeconds: async () => 2,
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

  // The sidecar the project reads: the shared template-data contract.
  assert.deepEqual(
    JSON.parse(await readFile(ctx.tpl.dataFile, "utf8")),
    buildTemplateData({
      props: { ...ctx.props, presetId: "vertical-9x16" },
      preset: renderPreset("vertical-9x16"),
      durationInFrames: 60,
      resolveAsset: (relative) => path.join(PUBLIC_DIR, relative),
    }),
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
  assert.match(record.template.visualizerVersion, /^aep-sha256:[0-9a-f]{16}$/);
  assert.equal(record.output.path, ae.label);
  assert.doesNotMatch(JSON.stringify(record), new RegExp(tmpdir().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  // Its fingerprint is After Effects' and this template's, never Remotion's.
  const { manifest } = readExportManifest(ae.manifest, ctx.f.slug, "vertical-9x16");
  assert.ok(manifest);
  assert.notEqual(manifest.inputs.visualizer, fingerprintInputs(ctx.props, "vertical-9x16").visualizer);
  assert.notEqual(
    manifest.inputs.visualizer,
    fingerprintInputs(ctx.props, "vertical-9x16", PUBLIC_DIR, "after-effects").visualizer,
    "the template identity is part of it too",
  );

  // Diagnostics name the binary, project, composition and output.
  const logText = ctx.logs.join("\n");
  for (const expected of [FAKE_AERENDER, ctx.tpl.project, `composition "Toshi 9x16"`, ctx.tpl.dataFile, "rendering to"]) {
    assert.ok(logText.includes(expected), `log mentions ${expected}`);
  }
});

test("editing the After Effects project changes the template version", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  await renderTrackVideo({ engine: ctx.engine, slug: ctx.f.slug, props: ctx.props, presetId: "square-1x1" });
  await writeFile(ctx.tpl.project, "an edited project");
  await renderTrackVideo({ engine: ctx.engine, slug: ctx.f.slug, props: ctx.props, presetId: "square-1x1" });

  const [first, second] = libraryFor(ctx.f.slug);
  assert.equal(first.template.composition, "Toshi Visualizer");
  assert.notEqual(first.template.visualizerVersion, second.template.visualizerVersion);
  assert.equal(second.exportKind, "reexport");
  assert.ok(second.replaces?.changed.includes("visualizer_changed"));
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
