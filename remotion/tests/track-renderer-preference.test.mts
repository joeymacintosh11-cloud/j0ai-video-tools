import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test, { type TestContext } from "node:test";
import { handleRequest } from "../server/app.ts";
import { TrackError } from "../core/domain/tracks/errors.ts";
import type { RenderEngine } from "../core/ports/renderEngine.ts";
import { createRenderEngineRegistry } from "../core/ports/renderEngineRegistry.ts";
import {
  coerceMetadataDraft,
  serializeTrackMetadata,
  validateTrackMetadata,
} from "../core/domain/tracks/metadata.ts";
import {
  DEFAULT_RENDERER_ID,
  remotionOnlyProblem,
  resolveTrackRenderer,
} from "../core/domain/video/renderers.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { deriveContentPackage } from "../core/domain/content/contentPackage.ts";
import { parseTrackMetadata as parseMetadataStrict } from "../core/domain/tracks/metadata.ts";
import type { RenderPresetId } from "../core/domain/video/renderPresets.ts";
import type { RendererId } from "../core/domain/video/renderers.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { toTrackSummaryView } from "../services/workflows/trackView.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { fixture } from "./fixtures.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

await isolateRenderJournalForThisFile();

/**
 * A track's preferred renderer: stored in metadata.json alongside the rest of
 * its intent, defaulting to Remotion when undeclared, and validated against
 * the shared renderer ids.
 */

const api = async (t: TestContext) => {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};

const VALID = { title: "T", artist: "A", key: "F Minor", bpm: 100 };

/* ------------------------------------------------------------------ *
 * Model and validation
 * ------------------------------------------------------------------ */

test("a track with no renderer declared resolves to Remotion, and its file gains no renderer key", () => {
  const { metadata, issues } = validateTrackMetadata(VALID, "metadata.json");
  assert.deepEqual(issues, []);
  assert.equal(metadata?.renderer, undefined);
  assert.equal(resolveTrackRenderer(metadata?.renderer), "remotion");
  assert.equal(DEFAULT_RENDERER_ID, "remotion");

  // Rewriting an old track never invents a preference.
  const written = JSON.parse(serializeTrackMetadata({ ...VALID, bpm: 100 }));
  assert.equal("renderer" in written, false);
});

test("a known renderer id is accepted and kept, including one not installed here", () => {
  for (const renderer of ["remotion", "after-effects", "premiere"] as const) {
    const { metadata, issues } = validateTrackMetadata({ ...VALID, renderer }, "metadata.json");
    assert.deepEqual(issues, [], renderer);
    assert.equal(metadata?.renderer, renderer);
    assert.equal(resolveTrackRenderer(metadata?.renderer), renderer);
  }
});

test("an unknown or removed renderer id is a validation error, never silently replaced", () => {
  for (const renderer of ["photoshop", "", 42, null, ["remotion"]]) {
    const { metadata, issues } = validateTrackMetadata({ ...VALID, renderer }, "metadata.json");
    assert.equal(metadata, null, JSON.stringify(renderer));
    assert.ok(
      issues.some((issue) => issue.code === "METADATA_INVALID" && /"renderer"/.test(issue.message)),
      JSON.stringify(issues),
    );
  }
});

test("the editor draft drops an unknown renderer rather than guessing one", () => {
  assert.equal(coerceMetadataDraft({ ...VALID, renderer: "photoshop" })?.renderer, undefined);
  assert.equal(coerceMetadataDraft({ ...VALID, renderer: "after-effects" })?.renderer, "after-effects");
  assert.equal(coerceMetadataDraft(VALID)?.renderer, undefined);
});

test("the Remotion-only message names the preference, and Remotion itself is never left out", () => {
  assert.equal(remotionOnlyProblem("remotion", "Delivery"), null);
  const message = remotionOnlyProblem("after-effects", "Delivery");
  assert.match(message ?? "", /prefers After Effects/);
  assert.match(message ?? "", /Delivery works with Remotion exports only/);
});

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

test("a renderer preference is saved to metadata.json and read back, and null clears it", async (t) => {
  const f = await fixture(t);

  await updateTrackMetadata(f.slug, { renderer: "after-effects" });
  assert.equal(JSON.parse(await fs.readFile(f.metadata, "utf8")).renderer, "after-effects");
  assert.equal((await inspectTrack(f.slug)).metadata?.renderer, "after-effects");

  // Saving an unrelated field keeps it — a title edit never resets the engine.
  await updateTrackMetadata(f.slug, { title: "Renamed" });
  assert.equal((await inspectTrack(f.slug)).metadata?.renderer, "after-effects");

  await updateTrackMetadata(f.slug, { renderer: null });
  const cleared = JSON.parse(await fs.readFile(f.metadata, "utf8"));
  assert.equal("renderer" in cleared, false);
  assert.equal(resolveTrackRenderer((await inspectTrack(f.slug)).metadata?.renderer), "remotion");
});

test("PATCH /api/tracks/:slug/metadata persists the preference, and rejects an unknown id without writing", async (t) => {
  const f = await fixture(t);
  const base = await api(t);
  const url = `${base}/api/tracks/${f.slug}`;
  const patch = (body: unknown) =>
    fetch(`${url}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const saved = await patch({ renderer: "after-effects" });
  assert.equal(saved.status, 200);
  const view = (await saved.json()).data;
  assert.equal(view.metadata.renderer, "after-effects");
  assert.equal(view.renderer, "after-effects");

  // Survives a fresh read — the route wrote it, it is not only in the response.
  const reread = (await (await fetch(url)).json()).data;
  assert.equal(reread.renderer, "after-effects");

  const before = await fs.readFile(f.metadata);
  const unknown = await patch({ renderer: "photoshop" });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, "INVALID_RENDERER");
  assert.deepEqual(await fs.readFile(f.metadata), before);

  const cleared = await patch({ renderer: null });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).data.renderer, null);
});

test("an older track's view reports no preference and judges Remotion exports, exactly as before", async (t) => {
  const f = await fixture(t);
  const base = await api(t);
  const view = (await (await fetch(`${base}/api/tracks/${f.slug}`)).json()).data;

  assert.equal(view.renderer, null);
  for (const output of view.exports) {
    assert.match(output.outputLabel, new RegExp(`^out/${f.slug}/[a-z0-9-]+\\.mp4$`));
  }
});

/* ------------------------------------------------------------------ *
 * Availability: registry status and GET /api/renderers
 * ------------------------------------------------------------------ */

const stubEngine = (id: RenderEngine["id"]): RenderEngine => ({
  id,
  open: async () => {
    throw new Error("not used");
  },
});

const withEnv = (t: TestContext, values: Record<string, string | undefined>) => {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
};

test("registry status separates ready, not installed, not configured and not implemented — loading nothing", () => {
  let loads = 0;
  let installed = true;
  let configProblem: string | null = "after-effects.local.json is missing.";
  const registry = createRenderEngineRegistry({
    remotion: async () => {
      loads += 1;
      return stubEngine("remotion");
    },
    "after-effects": {
      load: async () => {
        loads += 1;
        return stubEngine("after-effects");
      },
      probe: () => (installed ? null : "aerender was not found."),
      configured: () => configProblem,
    },
  });

  const byId = () => Object.fromEntries(registry.status().map((entry) => [entry.id, entry]));

  assert.deepEqual(registry.status().map((entry) => entry.id), ["remotion", "premiere", "after-effects"]);
  assert.deepEqual(byId().remotion, { id: "remotion", implemented: true, state: "ready", problem: null });
  assert.equal(byId().premiere.implemented, false);
  assert.equal(byId().premiere.state, "unavailable");
  assert.deepEqual(byId()["after-effects"], {
    id: "after-effects",
    implemented: true,
    state: "not_configured",
    problem: "after-effects.local.json is missing.",
  });

  // A configuration problem never changes what a caller naming the engine
  // gets: it is still "available", and the problem surfaces when it opens.
  assert.equal(registry.assertAvailable("after-effects"), "after-effects");

  configProblem = null;
  assert.equal(byId()["after-effects"].state, "ready");

  // Not installed outranks not configured: there is nothing to configure yet.
  installed = false;
  configProblem = "after-effects.local.json is missing.";
  assert.deepEqual(byId()["after-effects"], {
    id: "after-effects",
    implemented: true,
    state: "unavailable",
    problem: "aerender was not found.",
  });
  assert.throws(
    () => registry.assertAvailable("after-effects"),
    (error: unknown) => error instanceof TrackError && error.code === "RENDERER_UNAVAILABLE",
  );

  assert.equal(loads, 0);
});

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_AERENDER = path.join(PROJECT_ROOT, "tests", "fake-aerender.mjs");

const renderers = async (base: string) => {
  const response = await fetch(`${base}/api/renderers`);
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  return { body, byId: Object.fromEntries(body.renderers.map((entry: { id: string }) => [entry.id, entry])) };
};

test("GET /api/renderers reports this machine's engines, live, with After Effects' exact problem", async (t) => {
  const base = await api(t);
  const dir = await fs.mkdtemp(path.join(tmpdir(), "toshi-renderers-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const config = path.join(dir, "after-effects.local.json");

  // Not installed.
  withEnv(t, { TOSHI_AERENDER_PATH: "/nonexistent/toshi-test/aerender", TOSHI_AE_CONFIG: config });
  const first = await renderers(base);
  let { byId } = first;
  assert.equal(first.body.defaultRenderer, "remotion");
  assert.equal(byId.remotion.state, "ready");
  assert.equal(byId.premiere.implemented, false);
  assert.equal(byId["after-effects"].state, "unavailable");
  assert.match(byId["after-effects"].problem, /TOSHI_AERENDER_PATH points to/);

  // Installed, but no configuration file yet.
  process.env.TOSHI_AERENDER_PATH = FAKE_AERENDER;
  ({ byId } = await renderers(base));
  assert.equal(byId["after-effects"].state, "not_configured");
  assert.match(byId["after-effects"].problem, /needs a template/);

  // Installed and configured: picked up without a restart.
  const project = path.join(dir, "Toshi.aep");
  await fs.writeFile(project, "not really an aep");
  await fs.writeFile(config, JSON.stringify({ project, composition: "Toshi Visualizer" }));
  ({ byId } = await renderers(base));
  assert.deepEqual(byId["after-effects"], {
    id: "after-effects",
    implemented: true,
    state: "ready",
    problem: null,
  });

  assert.equal((await fetch(`${base}/api/renderers`, { method: "POST" })).status, 404);
});

/* ------------------------------------------------------------------ *
 * Freshness against the preferred renderer
 * ------------------------------------------------------------------ */

/** A track with real cover/audio, and helpers to publish either engine's export. */
const renderableTrack = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const f = await fixture(t, extra);
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  t.after(() => fs.rm(f.outputDir, { recursive: true, force: true }));

  const props = async () =>
    buildTrackProps({
      slug: f.slug,
      metadata: parseMetadataStrict(JSON.parse(await fs.readFile(f.metadata, "utf8")), "fixture"),
      analysisAvailable: true,
    });

  const publish = async (renderer: RendererId, presetId: RenderPresetId = "youtube-16x9") =>
    publishExport(
      f.slug,
      presetId,
      fingerprintInputs(
        await props(),
        presetId,
        undefined,
        renderer,
        // What the After Effects engine reports for its template.
        renderer === "remotion" ? undefined : { composition: "Toshi Visualizer", version: "aep-sha256:0123456789abcdef" },
      ),
      async (file) => {
        await fs.writeFile(file, `${renderer} video`);
      },
      undefined,
      undefined,
      renderer,
    );

  const view = async () => toTrackSummaryView(await inspectTrack(f.slug));
  const youtube = async () => (await view()).exports.find((output) => output.presetId === "youtube-16x9")!;

  return { ...f, publish, view, youtube };
};

test("a Remotion export does not satisfy a track that prefers After Effects", async (t) => {
  const f = await renderableTrack(t);
  await f.publish("remotion");

  // No preference: exactly as before.
  assert.equal((await f.view()).exportsRenderer, "remotion");
  assert.equal((await f.youtube()).freshness, "current");

  await updateTrackMetadata(f.slug, { renderer: "after-effects" });
  const view = await f.view();
  assert.equal(view.exportsRenderer, "after-effects");
  const youtube = view.exports.find((output) => output.presetId === "youtube-16x9")!;
  assert.equal(youtube.freshness, "missing");
  assert.equal(youtube.present, false);
  assert.equal(youtube.outputLabel, `out/${f.slug}/after-effects/youtube-16x9.mp4`);

  await f.publish("after-effects");
  assert.equal((await f.youtube()).freshness, "current");
  assert.equal((await f.youtube()).outputPath?.endsWith(`${f.slug}/after-effects/youtube-16x9.mp4`), true);

  // Back to the default: the Remotion export is what counts again.
  await updateTrackMetadata(f.slug, { renderer: null });
  assert.equal((await f.youtube()).freshness, "current");
  assert.match((await f.youtube()).outputLabel, new RegExp(`^out/${f.slug}/youtube-16x9\\.mp4$`));
});

test("an After Effects export does not satisfy a track that prefers Remotion", async (t) => {
  const f = await renderableTrack(t);
  await f.publish("after-effects");

  assert.equal((await f.view()).exportsRenderer, "remotion");
  assert.equal((await f.youtube()).freshness, "missing");
});

test("an After Effects export goes stale when the track's own inputs change", async (t) => {
  const f = await renderableTrack(t, { renderer: "after-effects" });
  await f.publish("after-effects");
  assert.equal((await f.youtube()).freshness, "current");

  await updateTrackMetadata(f.slug, { title: "A New Title" });
  const youtube = await f.youtube();
  assert.equal(youtube.freshness, "stale");
  assert.deepEqual(youtube.staleReasons, ["metadata_changed"]);
});

test("coverage without a renderer still judges Remotion's exports, for every existing caller", async (t) => {
  const f = await renderableTrack(t, { renderer: "after-effects" });
  await f.publish("remotion");

  const remotion = trackExportCoverage(f.slug).find((facts) => facts.presetId === "youtube-16x9")!;
  assert.equal(remotion.freshness, "current");
  assert.equal(remotion.outputLabel, `out/${f.slug}/youtube-16x9.mp4`);
});

test("for a track that prefers another renderer, delivery and the release bundle say they handle Remotion only", async (t) => {
  const f = await renderableTrack(t, { renderer: "after-effects" });
  await f.publish("after-effects");

  const view = await f.view();
  for (const output of view.exports) {
    assert.deepEqual(output.delivery, {
      status: "not_configured",
      reason: "renderer_not_supported",
      destinationPath: null,
      destinationRelativePath: null,
      deliveredAt: null,
    });
  }
  assert.equal(view.releaseBundle.freshness, "not_configured");
  assert.match(view.releaseBundle.problem ?? "", /prefers After Effects; A release bundle works with Remotion exports only/);
});

test("a content package blocks a track that prefers another renderer, with the reason and nothing to do", () => {
  const exports = (["youtube-16x9", "vertical-9x16", "square-1x1"] as const).map((presetId) => ({
    presetId,
    status: "missing" as const,
    staleReasons: [],
    intended: true,
    delivery: { status: "not_configured" as const, destinationRelativePath: null },
  }));
  const input = { slug: "x", title: "X", validationOk: true, metadata: null, exports };

  const remotion = deriveContentPackage(input, { now: () => "t" });
  assert.equal(remotion.packageStatus, "incomplete");
  assert.ok(remotion.platforms.some((platform) => platform.actions.includes("render")));

  // Omitted and explicit Remotion are the same package.
  assert.deepEqual(deriveContentPackage({ ...input, renderer: "remotion" }, { now: () => "t" }), remotion);

  const ae = deriveContentPackage({ ...input, renderer: "after-effects" }, { now: () => "t" });
  assert.equal(ae.packageStatus, "blocked");
  for (const platform of ae.platforms.filter((entry) => entry.selected)) {
    assert.equal(platform.readiness, "blocked");
    assert.deepEqual(platform.actions, []);
    assert.ok(platform.blockers.some((blocker) => /prefers After Effects/.test(blocker)));
  }
});
