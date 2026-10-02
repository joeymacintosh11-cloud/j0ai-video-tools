import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import type { VisualizerProps } from "../core/domain/video/visualizerProps.ts";
import {
  makeCancelSignal,
  type RenderEngine,
  type RenderSession,
  type RenderTemplateIdentity,
} from "../core/ports/renderEngine.ts";
import { readDeliverySettings } from "../services/delivery/deliverySettings.ts";
import { contentLibraryPath, readContentLibrary } from "../services/library/contentLibraryLog.ts";
import { renderTrackVideo } from "../services/render/renderTrackVideo.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { createHash } from "node:crypto";
import { parseContentLibraryLine } from "../core/domain/library/contentLibrary.ts";
import { storedRendererId } from "../core/domain/video/renderers.ts";
import { VISUALIZER_VERSION } from "../core/domain/video/exportFreshness.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { fileContentHash, fingerprintInputs, readExportManifest } from "../services/tracks/exportManifest.ts";
import { PUBLIC_DIR, trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { fixture } from "./fixtures.mts";

/**
 * The RenderEngine port (core/ports/renderEngine.ts), exercised through the
 * real engine path with a stand-in renderer instead of Remotion: whatever
 * engine is plugged in, renderTrackVideo still locks, fingerprints, publishes
 * and records exactly as before.
 */

// Never write into this repository's real out/.content-library/.
const libraryDir = await mkdtemp(path.join(tmpdir(), "toshi-engine-port-library-"));
process.env.TOSHI_CONTENT_LIBRARY_DIR = libraryDir;
test.after(() => rm(libraryDir, { recursive: true, force: true }));

type Call = string;

const fakeEngine = (
  calls: Call[],
  options: {
    failRender?: Error;
    content?: string;
    id?: RenderEngine["id"];
    template?: RenderTemplateIdentity;
  } = {},
): RenderEngine => ({
  // A stand-in renderer; which id it claims matters only where a test says so.
  id: options.id ?? "remotion",
  open: async (openOptions): Promise<RenderSession> => {
    calls.push("open");
    openOptions?.log?.("fake engine opened");
    return {
      // Reads public/ in place, as a non-bundling engine would.
      assetRoot: PUBLIC_DIR,
      resolve: async (props: VisualizerProps) => {
        calls.push(`resolve:${props.presetId}`);
        return {
          durationInFrames: 90,
          fps: 30,
          width: 1080,
          height: 1920,
          ...(options.template ? { template: options.template } : {}),
        };
      },
      render: async ({ outputPath, onProgress }) => {
        calls.push("render");
        if (options.failRender) throw options.failRender;
        onProgress?.({ progress: 1, renderedFrames: 90, encodedFrames: 90, stitchStage: "muxing" });
        await writeFile(outputPath, options.content ?? "fake video");
      },
      close: async () => {
        calls.push("close");
      },
    };
  },
});

const setup = async (t: TestContext) => {
  const settings = await readDeliverySettings();
  if (settings.autoDeliver && settings.root !== null) {
    // renderTrackVideo auto-delivers when this machine is set up to; a fixture
    // must never land in a real delivery folder.
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
  return { f, props };
};

test("makeCancelSignal runs every callback once, including ones registered after cancel", () => {
  const { cancelSignal, cancel } = makeCancelSignal();
  const seen: string[] = [];
  cancelSignal(() => seen.push("before"));
  cancel();
  cancel();
  cancelSignal(() => seen.push("after"));
  assert.deepEqual(seen, ["before", "after"]);
});

test("renderTrackVideo drives any RenderEngine through open, resolve, render and close, then publishes", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const calls: Call[] = [];
  const progress: number[] = [];

  const result = await renderTrackVideo({
    engine: fakeEngine(calls, { content: "engine output" }),
    slug: ctx.f.slug,
    props: ctx.props,
    presetId: "vertical-9x16",
    onProgress: (update) => progress.push(update.progress),
  });

  assert.deepEqual(calls, ["open", "resolve:vertical-9x16", "render", "close"]);
  assert.deepEqual(progress, [1]);

  const output = trackOutputLocation(ctx.f.slug, "vertical-9x16");
  assert.deepEqual(result, {
    durationInFrames: 90,
    fps: 30,
    width: 1080,
    height: 1920,
    outputPath: output.path,
    outputLabel: output.label,
  });
  assert.equal(await readFile(output.path, "utf8"), "engine output");

  // Fingerprinted from the session's assetRoot and recorded, exactly as a
  // Remotion render is.
  const { manifest } = readExportManifest(output.manifest, ctx.f.slug, "vertical-9x16");
  assert.ok(manifest, "a manifest was written next to the export");
  const records = readContentLibrary().records.filter((record) => record.track.slug === ctx.f.slug);
  assert.equal(records.length, 1, "the export was recorded in the content library");
  assert.equal(records[0].preset.id, "vertical-9x16");
});

test("a failing engine still has its session closed and publishes nothing", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const calls: Call[] = [];

  await assert.rejects(
    renderTrackVideo({
      engine: fakeEngine(calls, { failRender: new Error("engine exploded") }),
      slug: ctx.f.slug,
      props: ctx.props,
      presetId: "square-1x1",
    }),
    /engine exploded/,
  );

  assert.deepEqual(calls, ["open", "resolve:square-1x1", "render", "close"]);
  const output = trackOutputLocation(ctx.f.slug, "square-1x1");
  assert.equal(readExportManifest(output.manifest, ctx.f.slug, "square-1x1").manifest, null);
  assert.equal(readContentLibrary().records.some((record) => record.track.slug === ctx.f.slug), false);
});

test("a render cancelled before it starts never opens the engine", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const calls: Call[] = [];
  const { cancelSignal, cancel } = makeCancelSignal();
  cancel();

  await assert.rejects(
    renderTrackVideo({
      engine: fakeEngine(calls),
      slug: ctx.f.slug,
      props: ctx.props,
      cancelSignal,
    }),
    /got cancelled/,
  );
  assert.deepEqual(calls, []);
});

/* ------------------------------------------------------------------ *
 * Renderer identity: recorded, and part of freshness
 * ------------------------------------------------------------------ */

test("Remotion's export fingerprint is byte-for-byte what it was before renderers were recorded", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;

  const implicit = fingerprintInputs(ctx.props, "youtube-16x9");
  assert.deepEqual(fingerprintInputs(ctx.props, "youtube-16x9", PUBLIC_DIR, "remotion"), implicit);

  // The visualizer hash exactly as exportManifest.ts computed it before
  // renderers existed, so every manifest already on disk stays current.
  const legacyVisualizer = createHash("sha256")
    .update(
      JSON.stringify([
        VISUALIZER_VERSION,
        fileContentHash(path.join(PUBLIC_DIR, ctx.props.brandLogoSrc)),
        fileContentHash(path.join(PUBLIC_DIR, ctx.props.brandBadgeSrc)),
      ]),
    )
    .digest("hex");
  assert.equal(implicit.visualizer, legacyVisualizer);
});

test("another renderer changes only the visualizer fingerprint", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;

  const remotion = fingerprintInputs(ctx.props, "square-1x1");
  const premiere = fingerprintInputs(ctx.props, "square-1x1", PUBLIC_DIR, "premiere");
  const afterEffects = fingerprintInputs(ctx.props, "square-1x1", PUBLIC_DIR, "after-effects");

  assert.notEqual(premiere.visualizer, remotion.visualizer);
  assert.notEqual(premiere.visualizer, afterEffects.visualizer);
  assert.deepEqual({ ...premiere, visualizer: null }, { ...remotion, visualizer: null });
});

test("a Remotion render is recorded as Remotion and is current", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;

  await renderTrackVideo({
    engine: fakeEngine([]),
    slug: ctx.f.slug,
    props: ctx.props,
    presetId: "youtube-16x9",
  });

  const [record] = readContentLibrary().records.filter((entry) => entry.track.slug === ctx.f.slug);
  assert.equal(record.template.renderer, "remotion");
  const facts = trackExportCoverage(ctx.f.slug).find((entry) => entry.presetId === "youtube-16x9");
  assert.equal(facts?.freshness, "current");
});

test("another engine's export records its renderer and is not mistaken for a current Remotion export", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;

  await renderTrackVideo({
    engine: fakeEngine([], { id: "premiere" }),
    slug: ctx.f.slug,
    props: ctx.props,
    presetId: "vertical-9x16",
  });

  const [record] = readContentLibrary().records.filter((entry) => entry.track.slug === ctx.f.slug);
  assert.equal(record.template.renderer, "premiere");

  // Freshness is judged against the default renderer, so the export is stale
  // on the visualizer axis and nothing else.
  const facts = trackExportCoverage(ctx.f.slug).find((entry) => entry.presetId === "vertical-9x16");
  assert.equal(facts?.freshness, "stale");
  assert.deepEqual(facts?.staleReasons, ["visualizer_changed"]);
});

test("library records from before renderers were recorded still parse, and read back as Remotion", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;

  // A real record, as this code writes it, then aged back to the old shape.
  await renderTrackVideo({ engine: fakeEngine([]), slug: ctx.f.slug, props: ctx.props, presetId: "square-1x1" });
  const line = (await readFile(contentLibraryPath(), "utf8"))
    .split("\n")
    .find((row) => row.includes(ctx.f.slug));
  assert.ok(line);
  const written = JSON.parse(line);
  assert.equal(written.template.renderer, "remotion");

  const { renderer: _dropped, ...oldTemplate } = written.template;
  void _dropped;
  const legacy = parseContentLibraryLine(JSON.stringify({ ...written, template: oldTemplate }));
  assert.ok(legacy.ok, legacy.ok ? "" : legacy.message);
  assert.equal("renderer" in legacy.record.template, false);
  assert.equal(storedRendererId(legacy.record.template.renderer), "remotion");

  const future = parseContentLibraryLine(
    JSON.stringify({ ...written, template: { ...written.template, renderer: "cloud-farm" } }),
  );
  assert.ok(future.ok, "a renderer this version does not know never hides the record");
  assert.equal(storedRendererId(future.record.template.renderer), null);
});

test("an engine-reported template is fingerprinted and recorded; its log reaches the caller", async (t) => {
  const ctx = await setup(t);
  if (!ctx) return;
  const logs: string[] = [];
  const template = { composition: "Visualizer 1x1", version: "aep-sha256:0123456789abcdef" };

  await renderTrackVideo({
    engine: fakeEngine([], { template }),
    slug: ctx.f.slug,
    props: ctx.props,
    presetId: "square-1x1",
    onEngineLog: (message) => logs.push(message),
  });

  assert.deepEqual(logs, ["fake engine opened"]);
  const [record] = readContentLibrary().records.filter((entry) => entry.track.slug === ctx.f.slug);
  assert.equal(record.template.composition, "Visualizer 1x1");
  assert.equal(record.template.visualizerVersion, "aep-sha256:0123456789abcdef");

  // The template is a visualizer input: another version is another fingerprint,
  // and leaving it out is exactly the built-in visualizer's fingerprint.
  const base = fingerprintInputs(ctx.props, "square-1x1", PUBLIC_DIR, "remotion");
  const withTemplate = fingerprintInputs(ctx.props, "square-1x1", PUBLIC_DIR, "remotion", template);
  const edited = fingerprintInputs(ctx.props, "square-1x1", PUBLIC_DIR, "remotion", { ...template, version: "aep-sha256:fedcba9876543210" });
  assert.notEqual(withTemplate.visualizer, base.visualizer);
  assert.notEqual(edited.visualizer, withTemplate.visualizer);
  assert.deepEqual({ ...withTemplate, visualizer: null }, { ...base, visualizer: null });
  assert.deepEqual(fingerprintInputs(ctx.props, "square-1x1", PUBLIC_DIR, "remotion", undefined), base);
});
