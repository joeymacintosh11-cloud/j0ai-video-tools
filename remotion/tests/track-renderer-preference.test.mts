import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
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
import { deliverAfterRender } from "../services/delivery/autoDeliver.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import type { DeliverySettings } from "../services/delivery/deliverySettings.ts";
import { generateReleaseBundle } from "../services/delivery/releaseBundle.ts";
import { planDeliveries } from "../services/workflows/deliveryPlan.ts";
import { planDestinationFix } from "../services/workflows/destinationFixPlan.ts";
import { planMissingExports } from "../services/workflows/exportPlan.ts";
import { planReleaseBundles } from "../services/workflows/releaseBundlePlan.ts";
import { revealTrackOutput } from "../services/tracks/revealTrackOutput.ts";
import type { RendererStatus } from "../core/domain/video/renderers.ts";
import {
  engineOptions,
  engineStateLabel,
  renderBlockedReason,
  trackEngine,
} from "../ui/components/engineModel.ts";
import { batchTargets, catalogueBatchTargets, rendererPatch, startRenderBody } from "../ui/api/engineRequest.ts";
import { exportStatusKey } from "../core/domain/render/exportStatus.ts";
import { managerWithWorkers, tick, Worker } from "./managerHarness.mts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { fixture } from "./fixtures.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";
import { syntheticTemplate } from "./syntheticTemplate.mts";

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
  const template = await syntheticTemplate(t);
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
        renderer === "remotion" ? undefined : template,
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

test("AE delivery can be configured independently; release bundles remain Remotion-only", async (t) => {
  const f = await renderableTrack(t, { renderer: "after-effects" });
  await f.publish("after-effects");

  const view = await f.view();
  for (const output of view.exports) {
    assert.deepEqual(output.delivery, {
      status: "not_configured",
      reason: "not_configured",
      destinationPath: null,
      destinationRelativePath: null,
      deliveredAt: null,
    });
  }
  assert.equal(view.releaseBundle.freshness, "not_configured");
  assert.match(view.releaseBundle.problem ?? "", /prefers After Effects; A release bundle works with Remotion exports only/);
});

test("content packages support AE while unimplemented renderer workflows remain blocked", () => {
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
  assert.equal(ae.packageStatus, "incomplete");
  assert.equal(ae.renderer, "after-effects");
  assert.ok(ae.platforms.filter((entry) => entry.selected).every((entry) => entry.actions.includes("render")));
  const unsupported = deriveContentPackage({ ...input, renderer: "premiere" }, { now: () => "t" });
  assert.equal(unsupported.packageStatus, "blocked");
  for (const platform of unsupported.platforms.filter((entry) => entry.selected)) {
    assert.equal(platform.readiness, "blocked");
    assert.deepEqual(platform.actions, []);
    assert.ok(platform.blockers.some((blocker) => /not implemented/.test(blocker)));
  }
});

/* ------------------------------------------------------------------ *
 * Remotion-only pipelines leave a non-Remotion track out, and say why
 * ------------------------------------------------------------------ */

const destinationRoot = async (t: TestContext) => {
  const root = realpathSync(await fs.mkdtemp(path.join(tmpdir(), "toshi-renderer-pref-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

const settingsFor = (root: string | null, autoDeliver = false): DeliverySettings => ({
  schemaVersion: 1,
  root,
  autoDeliver,
  autoUpdateReleaseBundle: false,
});

const listFiles = async (root: string): Promise<readonly string[]> =>
  (await fs.readdir(root, { recursive: true })).map(String).sort();

test("Export missing plans preferred AE exports alongside unchanged Remotion targets", async (t) => {
  const remotion = await renderableTrack(t);
  const ae = await renderableTrack(t, { renderer: "after-effects" });
  await ae.publish("remotion");
  const plan = await planMissingExports({ slugs: [remotion.slug, ae.slug], mode: "missing-and-stale" });
  assert.ok(plan.selected.some((target) => target.slug === remotion.slug && target.engine === undefined));
  assert.ok(plan.selected.some((target) => target.slug === ae.slug && target.engine === "after-effects"));
  assert.ok(plan.selected.filter((target) => target.slug === ae.slug).every((target) => target.outputLabel.includes("/after-effects/")));
  assert.deepEqual(plan.invalid, []);
});

test("delivery never substitutes a Remotion export for a missing AE export", async (t) => {
  const root = await destinationRoot(t);
  const f = await renderableTrack(t, { renderer: "after-effects" });
  // A Remotion export sits there, ready to ship: it must not stand in.
  await f.publish("remotion");

  const plan = await planDeliveries({ slugs: [f.slug], settings: settingsFor(root) });
  assert.deepEqual(plan.deliverable, []);
  assert.deepEqual(plan.invalid, []);
  assert.ok(plan.notCurrent.every((target) => target.engine === "after-effects"));

  const outcome = await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings: settingsFor(root) });
  assert.equal(outcome.status, "pending");
  assert.equal(outcome.reason, "export_missing");
  assert.match(outcome.message ?? "", /after-effects/);

  assert.deepEqual(await listFiles(root), []);
});

test("a release bundle is neither planned nor written for a track that prefers After Effects", async (t) => {
  const root = await destinationRoot(t);
  const f = await renderableTrack(t, { renderer: "after-effects" });

  const plan = await planReleaseBundles({ slugs: [f.slug], settings: settingsFor(root) });
  assert.equal(plan.unavailable.length, 1);
  assert.match(plan.unavailable[0]?.problem ?? "", /prefers After Effects/);

  const result = await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });
  assert.equal(result.generated, false);
  assert.match(result.problem ?? "", /A release bundle works with Remotion exports only/);
  assert.deepEqual(await listFiles(root), []);
});

test("auto-delivery refuses a rendered engine that differs from the saved preference", async (t) => {
  const root = await destinationRoot(t);
  const f = await renderableTrack(t);
  await f.publish("remotion");

  const reported: string[] = [];
  const skipped = await deliverAfterRender(
    f.slug,
    "youtube-16x9",
    (outcome) => reported.push(outcome.reason ?? ""),
    "after-effects",
    settingsFor(root, true),
  );
  assert.equal(skipped?.status, "failed");
  assert.equal(skipped?.reason, "renderer_not_supported");
  assert.match(skipped?.message ?? "", /now prefers Remotion; the requested After Effects export was not delivered/);
  assert.deepEqual(reported, ["renderer_not_supported"]);
  assert.deepEqual(await listFiles(root), []);

  // After a Remotion render it delivers, exactly as before.
  const delivered = await deliverAfterRender(f.slug, "youtube-16x9", undefined, "remotion", settingsFor(root, true));
  assert.equal(delivered?.status, "delivered");
});

test("a destination fix plan leaves a track that now prefers After Effects for a person, never a Remotion re-render", async (t) => {
  const root = await destinationRoot(t);
  const f = await renderableTrack(t);
  await f.publish("remotion");
  const delivered = await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings: settingsFor(root) });
  assert.equal(delivered.status, "delivered");

  await updateTrackMetadata(f.slug, { renderer: "after-effects" });
  await fs.rm(delivered.destinationPath!);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const actions = plan.actions.filter((action) => action.slug === f.slug);
  assert.ok(actions.length > 0, JSON.stringify(plan));
  for (const action of actions) {
    assert.equal(action.kind, "manual_review", JSON.stringify(action));
    assert.equal(action.executable, false);
  }
  assert.ok(actions.some((action) => /prefers After Effects; Delivery repair works with Remotion exports only/.test(action.reason)));
});

/* ------------------------------------------------------------------ *
 * UI: the engine picker and the render request it leads to
 * ------------------------------------------------------------------ */

const STATUSES = (ae: RendererStatus["state"], problem: string | null = null): readonly RendererStatus[] => [
  { id: "remotion", implemented: true, state: "ready", problem: null },
  { id: "premiere", implemented: false, state: "unavailable", problem: "not built" },
  { id: "after-effects", implemented: true, state: ae, problem: ae === "ready" ? null : problem },
];

test("the picker offers Remotion and After Effects, never unbuilt Premiere, with After Effects' state", () => {
  const ready = engineOptions(STATUSES("ready"), "remotion");
  assert.deepEqual(ready.map((option) => option.id), ["remotion", "after-effects"]);
  assert.deepEqual(ready.map((option) => option.selectable), [true, true]);
  assert.deepEqual(ready.map((option) => option.label), ["Remotion", "After Effects"]);
  assert.equal(engineStateLabel("ready"), null);
});

test("an engine that cannot run here is shown but not pickable; not configured is pickable and labelled", () => {
  const unavailable = engineOptions(STATUSES("unavailable", "aerender was not found."), "remotion");
  const ae = unavailable.find((option) => option.id === "after-effects")!;
  assert.equal(ae.selectable, false);
  assert.equal(ae.problem, "aerender was not found.");
  assert.equal(engineStateLabel(ae.state), "not available");

  const notConfigured = engineOptions(STATUSES("not_configured", "needs a template"), "remotion");
  const aeNotConfigured = notConfigured.find((option) => option.id === "after-effects")!;
  assert.equal(aeNotConfigured.selectable, true);
  assert.equal(engineStateLabel(aeNotConfigured.state), "not configured");
});

test("a track's current engine is always shown and kept, even one unavailable or unbuilt here", () => {
  const stuck = engineOptions(STATUSES("unavailable", "aerender was not found."), "after-effects");
  assert.equal(stuck.find((option) => option.id === "after-effects")?.selectable, true);

  // A hand-edited "premiere" is visible as the current, unavailable choice.
  const premiere = engineOptions(STATUSES("ready"), "premiere");
  assert.deepEqual(premiere.map((option) => option.id), ["remotion", "premiere", "after-effects"]);
  assert.equal(premiere.find((option) => option.id === "premiere")?.state, "unavailable");
});

test("before availability loads, the default and the current choice show as checking, not unavailable", () => {
  assert.deepEqual(
    engineOptions(null, "remotion").map((option) => [option.id, option.state]),
    [["remotion", "checking"]],
  );
  assert.deepEqual(
    engineOptions(null, "after-effects").map((option) => [option.id, option.state, option.selectable]),
    [
      ["remotion", "checking", true],
      ["after-effects", "checking", true],
    ],
  );
});

test("the Render panel is blocked, with the reason, when the chosen engine cannot run — never silently Remotion", () => {
  assert.equal(renderBlockedReason("remotion", STATUSES("unavailable", "x")), null);
  assert.equal(renderBlockedReason("after-effects", STATUSES("ready")), null);
  assert.match(
    renderBlockedReason("after-effects", STATUSES("not_configured", "after-effects.local.json is missing.")) ?? "",
    /^After Effects is not configured: after-effects\.local\.json is missing\.$/,
  );
  assert.match(
    renderBlockedReason("after-effects", STATUSES("unavailable", "aerender was not found.")) ?? "",
    /^After Effects is not available here: aerender was not found\.$/,
  );
  // Unknown availability does not block; the server checks again.
  assert.equal(renderBlockedReason("after-effects", null), null);
});

test("the app's render requests name the track's engine, and an old track's requests are byte-identical", () => {
  assert.equal(trackEngine({ renderer: null }), "remotion");
  assert.equal(trackEngine({ renderer: "after-effects" }), "after-effects");

  assert.deepEqual(startRenderBody("square-1x1", "remotion"), { preset: "square-1x1" });
  assert.deepEqual(startRenderBody(undefined, "remotion"), {});
  assert.deepEqual(startRenderBody("square-1x1", "after-effects"), { preset: "square-1x1", engine: "after-effects" });

  assert.deepEqual(batchTargets("x", ["youtube-16x9", "square-1x1"], "remotion"), [
    { slug: "x", preset: "youtube-16x9" },
    { slug: "x", preset: "square-1x1" },
  ]);
  assert.deepEqual(batchTargets("x", ["youtube-16x9"], "after-effects"), [
    { slug: "x", preset: "youtube-16x9", engine: "after-effects" },
  ]);
});

test("through the real API: the app's request renders with the track's engine; one naming none is still Remotion", async (t) => {
  withEnv(t, { TOSHI_AERENDER_PATH: FAKE_AERENDER });
  const childProcess = (await import("node:child_process")).default;
  const forks: (readonly string[])[] = [];
  t.mock.method(childProcess, "fork", (_modulePath: string, args: readonly string[]) => {
    forks.push(args);
    const worker = new Worker();
    worker.pid = 4545;
    return worker;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const { renderManager } = await import("../services/workflows/renderManager.ts");

  const base = await api(t);
  const f = await renderableTrack(t, { renderer: "after-effects" });
  const view = (await (await fetch(`${base}/api/tracks/${f.slug}`)).json()).data;
  assert.equal(view.renderer, "after-effects");

  const post = async (url: string, body: unknown) => {
    const response = await fetch(`${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };

  // What RenderPanel sends for this track.
  const fromApp = await post(`/api/tracks/${f.slug}/render`, startRenderBody("square-1x1", trackEngine(view)));
  assert.equal(fromApp.status, 200);
  assert.equal(fromApp.json.data.job.engine, "after-effects");
  assert.equal(forks.at(-1)?.at(-1), "after-effects");

  // An older API caller naming no engine: Remotion, preference notwithstanding.
  const legacy = await post(`/api/tracks/${f.slug}/render`, { preset: "vertical-9x16" });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.json.data.job.engine, "remotion");

  // A batch from the app carries it per target.
  const batch = await post("/api/render-batches", {
    targets: await catalogueBatchTargets([f.slug], ["youtube-16x9"], async (slug) =>
      (await (await fetch(`${base}/api/tracks/${slug}`)).json()).data,
    ),
  });
  assert.equal(batch.status, 200);
  assert.equal(batch.json.data.batch.jobs[0].engine, "after-effects");

  // The real track route reports only work for the preferred renderer.
  // The Remotion job above must not make the AE vertical export look queued.
  const queuedView = (await (await fetch(`${base}/api/tracks/${f.slug}`)).json()).data;
  assert.equal(queuedView.exports.find((entry: { presetId: string }) => entry.presetId === "vertical-9x16").status, "missing");
  assert.equal(queuedView.exports.find((entry: { presetId: string }) => entry.presetId === "square-1x1").status, "rendering");
  assert.equal(queuedView.exports.find((entry: { presetId: string }) => entry.presetId === "youtube-16x9").status, "queued");

  for (const jobId of [fromApp.json.data.jobId, legacy.json.data.jobId, batch.json.data.batch.jobs[0].id]) {
    try {
      renderManager.cancelRender(jobId);
    } catch {
      // Already settled.
    }
  }
});

test("Show <format> reveals the track's own engine's file, never another engine's", async (t) => {
  const f = await renderableTrack(t, { renderer: "after-effects" });
  await f.publish("remotion");

  // Only a Remotion export exists: asking for the After Effects one names its
  // own path and is refused — it does not fall back to the Remotion file.
  await assert.rejects(revealTrackOutput(f.slug, "youtube-16x9", "after-effects"), (error: unknown) => {
    assert.ok(error instanceof TrackError);
    assert.equal(error.code, "TRACK_NOT_FOUND");
    assert.match(error.message, new RegExp(`out/${f.slug}/after-effects/youtube-16x9\\.mp4`));
    return true;
  });
  await assert.rejects(revealTrackOutput(f.slug, "youtube-16x9", "blender"), { code: "INVALID_RENDERER" });
});

/* ------------------------------------------------------------------ *
 * Regression: choosing an engine must persist on its own, across a reload
 * ------------------------------------------------------------------ */

test("the picker's own patch persists After Effects with no other save, and a fresh read restores it", async (t) => {
  const f = await fixture(t);
  const base = await api(t);
  const url = `${base}/api/tracks/${f.slug}`;
  const patch = async (body: unknown, revision: string) => {
    const response = await fetch(`${url}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": `"${revision}"` },
      body: JSON.stringify(body),
    });
    return { status: response.status, data: (await response.json()).data };
  };

  assert.deepEqual(rendererPatch("after-effects"), { renderer: "after-effects" });
  assert.deepEqual(rendererPatch("remotion"), { renderer: null });

  const first = (await (await fetch(url)).json()).data;
  const saved = await patch(rendererPatch("after-effects"), first.metadataRevision);
  assert.equal(saved.status, 200);

  // On disk, exactly as the brief names it.
  assert.equal(JSON.parse(await fs.readFile(f.metadata, "utf8")).renderer, "after-effects");

  // "Reload": a brand-new read restores it, and the form's initial value is it.
  const reloaded = (await (await fetch(url)).json()).data;
  assert.equal(reloaded.renderer, "after-effects");
  assert.equal(reloaded.exportsRenderer, "after-effects");
  assert.equal(resolveTrackRenderer(reloaded.renderer), "after-effects");

  // The revision the save returned is the one the next save is based on.
  const back = await patch(rendererPatch("remotion"), saved.data.metadataRevision);
  assert.equal(back.status, 200);
  assert.equal("renderer" in JSON.parse(await fs.readFile(f.metadata, "utf8")), false);
  const restored = (await (await fetch(url)).json()).data;
  assert.equal(restored.renderer, null);
  assert.equal(restored.exportsRenderer, "remotion");
});

test("a track written before renderers existed reads back unchanged after an engine round trip", async (t) => {
  const f = await fixture(t);
  const before = JSON.parse(await fs.readFile(f.metadata, "utf8"));

  await updateTrackMetadata(f.slug, rendererPatch("after-effects"));
  await updateTrackMetadata(f.slug, rendererPatch("remotion"));

  const after = JSON.parse(await fs.readFile(f.metadata, "utf8"));
  assert.deepEqual(after, before);
});


test("catalogue queue reads each saved preference and preserves legacy default requests", async () => {
  const reads: string[] = [];
  const targets = await catalogueBatchTargets(
    ["ae", "legacy", "explicit-remotion"],
    ["youtube-16x9", "square-1x1"],
    async (slug) => {
      reads.push(slug);
      return { renderer: slug === "ae" ? "after-effects" : slug === "legacy" ? null : "remotion" };
    },
  );
  assert.deepEqual(reads, ["ae", "legacy", "explicit-remotion"]);
  assert.deepEqual(targets, [
    ...batchTargets("ae", ["youtube-16x9", "square-1x1"], "after-effects"),
    ...batchTargets("legacy", ["youtube-16x9", "square-1x1"], "remotion"),
    ...batchTargets("explicit-remotion", ["youtube-16x9", "square-1x1"], "remotion"),
  ]);
});

test("catalogue queue refuses unread saved preferences instead of falling back", async () => {
  await assert.rejects(
    catalogueBatchTargets(["unread"], ["youtube-16x9"], async () => {
      throw new Error("Track read failed");
    }),
    /Track read failed/,
  );
});


for (const preferred of ["remotion", "after-effects"] as const) {
  test(`export status reflects only ${preferred} jobs for a track that prefers it`, async (t) => {
    const f = await renderableTrack(t, { renderer: preferred });
    const { manager, workers } = await managerWithWorkers(t);
    const inspection = await inspectTrack(f.slug);
    const other = preferred === "remotion" ? "after-effects" : "remotion";
    const mismatched = manager.startRender(f.slug, "youtube-16x9", other);
    const view = () => toTrackSummaryView(inspection, manager.inFlightExports());
    const youtube = () => view().exports.find((entry) => entry.presetId === "youtube-16x9")!;
    assert.equal(manager.inFlightExports().get(exportStatusKey(f.slug, "youtube-16x9", other)), "active");
    assert.equal(youtube().status, "missing");
    assert.equal(youtube().active, false);
    assert.equal(youtube().queued, false);
    // Contention is still shared across engines, independently of status.
    assert.throws(() => manager.startRender(f.slug, "youtube-16x9", preferred), { code: "RENDER_ALREADY_ACTIVE" });
    workers[0].emit("close", 1, null);
    await tick();
    assert.equal(manager.getJob(mismatched.id).status, "failed");
    assert.equal(manager.inFlightExports().size, 0);

    // Hold the slot with unrelated work, then queue the preferred engine.
    manager.startRender("status-slot-holder", "square-1x1");
    manager.startRender(f.slug, "youtube-16x9", preferred);
    assert.equal(youtube().status, "queued");
    assert.equal(youtube().queued, true);
    workers[1].emit("close", 1, null);
    await tick();
    assert.equal(youtube().status, "rendering");
    assert.equal(youtube().active, true);
    workers[2].emit("close", 1, null);
    await tick();
    assert.equal(youtube().status, "missing");
    assert.equal(manager.inFlightExports().size, 0);
  });
}
