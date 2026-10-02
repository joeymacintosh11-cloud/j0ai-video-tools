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
} from "../core/ports/renderEngine.ts";
import { readDeliverySettings } from "../services/delivery/deliverySettings.ts";
import { readContentLibrary } from "../services/library/contentLibraryLog.ts";
import { renderTrackVideo } from "../services/render/renderTrackVideo.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { readExportManifest } from "../services/tracks/exportManifest.ts";
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
  options: { failRender?: Error; content?: string } = {},
): RenderEngine => ({
  id: "fake",
  open: async (): Promise<RenderSession> => {
    calls.push("open");
    return {
      // Reads public/ in place, as a non-bundling engine would.
      assetRoot: PUBLIC_DIR,
      resolve: async (props: VisualizerProps) => {
        calls.push(`resolve:${props.presetId}`);
        return { durationInFrames: 90, fps: 30, width: 1080, height: 1920 };
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
