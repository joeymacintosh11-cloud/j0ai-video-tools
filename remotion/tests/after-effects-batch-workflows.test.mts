import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { writeFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { tmpdir } from "node:os";
import test, { type TestContext } from "node:test";
import { fixture } from "./fixtures.mts";
import { managerWithWorkers, tick, Worker } from "./managerHarness.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { planMissingExports, toRenderTargets } from "../services/workflows/exportPlan.ts";
import { toTrackSummaryView } from "../services/workflows/trackView.ts";
import { buildContentPackagesForSlugs, planContentPackageBatch, toRenderTargetsFromPlan } from "../services/workflows/contentPackagePlan.ts";
import { deriveContentPackage } from "../core/domain/content/contentPackage.ts";
import { exportStatusKey } from "../core/domain/render/exportStatus.ts";
import type { RendererId, RendererStatus } from "../core/domain/video/renderers.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import { readDeliveryReceipt } from "../services/delivery/deliveryReceipt.ts";
import { deliverAfterRender } from "../services/delivery/autoDeliver.ts";
import { deliverPlanned, planDeliveries } from "../services/workflows/deliveryPlan.ts";
import { toSessionJobReferences, classifyRecoveredJob } from "../ui/batchSession.ts";
import { syntheticTemplate } from "./syntheticTemplate.mts";

await isolateRenderJournalForThisFile();

const READY: readonly RendererStatus[] = [
  { id: "remotion", implemented: true, state: "ready", problem: null },
  { id: "after-effects", implemented: true, state: "ready", problem: null },
];
const setup = async (t: TestContext, renderer?: RendererId) => {
  const template = await syntheticTemplate(t);
  const f = await fixture(t, { ...(renderer ? { renderer } : {}), exportPresets: ["youtube-16x9"] });
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  t.after(() => fs.rm(f.outputDir, { recursive: true, force: true }));
  const publish = async (engine: RendererId) => {
    const metadata = (await inspectTrack(f.slug)).metadata!;
    const props = buildTrackProps({ slug: f.slug, metadata, analysisAvailable: true });
    return publishExport(f.slug, "youtube-16x9",
      fingerprintInputs(props, "youtube-16x9", undefined, engine,
        engine === "after-effects" ? template : undefined),
      async (file) => { await fs.writeFile(file, `${engine} video`); }, undefined, undefined, engine);
  };
  return { ...f, publish };
};
const destination = async (t: TestContext) => {
  const root = realpathSync(await fs.mkdtemp(path.join(tmpdir(), "ae-delivery-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { schemaVersion: 1 as const, root, autoDeliver: true, autoUpdateReleaseBundle: false };
};
const packages = (slugs: readonly string[], renderers = READY) => buildContentPackagesForSlugs(slugs,
  { inFlight: new Map(), deliveryRoot: null, globalTemplates: null, templatesProblem: null, renderers });

for (const engines of [[undefined, "after-effects"], ["after-effects", "after-effects"]] as const) {
  test(`${engines[0] === undefined ? "mixed catalogue" : "AE-only"} batch preserves engines and executes serially through worker exit`, async (t) => {
    const tracks = await Promise.all(engines.map((engine) => setup(t, engine)));
    const plan = await planMissingExports({ slugs: tracks.map((f) => f.slug), renderers: READY });
    assert.deepEqual(plan.invalid, []);
    const { manager, workers } = await managerWithWorkers(t);
    const { batch } = manager.startBatch(toRenderTargets(plan));
    assert.deepEqual(batch.jobs.map((job) => job.engine), engines.map((engine) => engine ?? "remotion"));
    assert.equal(workers.length, 1);
    assert.equal(batch.active, 1);
    assert.equal(batch.queued, 1);
    const second = tracks[1];
    const view = toTrackSummaryView(await inspectTrack(second.slug), manager.inFlightExports());
    assert.equal(view.exports[0].status, "queued");
    assert.equal(view.exportsRenderer, "after-effects");
    assert.equal(manager.inFlightExports().get(exportStatusKey(second.slug, "youtube-16x9", "remotion")), undefined);
    workers[0].emit("message", { type: "done", outputPath: "test", outputLabel: "test" });
    await tick();
    assert.equal(workers.length, 1, "done IPC must not release shared footage before process exit");
    workers[0].emit("exit", 0, null);
    await tick();
    assert.equal(workers.length, 2);
    assert.equal(manager.getBatch(batch.id).jobs[1].status, "preparing");
    assert.ok(manager.getLogs(batch.jobs[1].id).some((entry) => entry.message.includes("serially")));
    workers[1].emit("message", { type: "done", outputPath: "test", outputLabel: "test" });
    workers[1].emit("exit", 0, null);
    await tick();
    assert.equal(manager.getBatch(batch.id).progress, 1);
    assert.equal(manager.getBatch(batch.id).completed, 2);
  });
}

test("missing and stale AE planning uses AE paths, and Remotion files never satisfy it", async (t) => {
  const f = await setup(t, "after-effects");
  await f.publish("remotion");
  const missing = await planMissingExports({ slugs: [f.slug], mode: "missing" });
  assert.equal(missing.selected.length, 1);
  assert.equal(missing.selected[0].engine, "after-effects");
  assert.match(missing.selected[0].outputLabel, /after-effects/);
  await f.publish("after-effects");
  assert.equal((await planMissingExports({ slugs: [f.slug], mode: "missing-and-stale" })).selected.length, 0);
  await updateTrackMetadata(f.slug, { title: "Changed" });
  const stale = await planMissingExports({ slugs: [f.slug], mode: "stale" });
  assert.equal(stale.selected.length, 1);
  assert.equal(stale.selected[0].engine, "after-effects");
  assert.deepEqual(stale.selected[0].staleReasons, ["metadata_changed"]);
});

test("AE content-package readiness and actions use only its preferred export", async (t) => {
  const f = await setup(t, "after-effects");
  await f.publish("remotion");
  const missing = await packages([f.slug]);
  const plan = planContentPackageBatch(missing);
  assert.deepEqual(toRenderTargetsFromPlan(plan), [{ slug: f.slug, preset: "youtube-16x9", engine: "after-effects" }]);
  await f.publish("after-effects");
  const ready = await packages([f.slug]);
  assert.ok(ready[0].found);
  if (ready[0].found) assert.equal(ready[0].package.packageStatus, "complete");
  assert.equal(planContentPackageBatch(ready).renderable.length, 0);
  await updateTrackMetadata(f.slug, { bpm: 101 });
  assert.equal(planContentPackageBatch(await packages([f.slug])).renderable[0].kind, "rerender_stale");
});

for (const state of ["unavailable", "not_configured"] as const) {
  test(`AE ${state} blocks required rendering but does not block an existing current package`, async (t) => {
    const f = await setup(t, "after-effects");
    const statuses = READY.map((entry) => entry.id === "after-effects" ? { ...entry, state, problem: "local test reason" } : entry);
    const blocked = planContentPackageBatch(await packages([f.slug], statuses));
    assert.equal(blocked.renderable.length, 0);
    assert.equal(blocked.blocked.length, 1);
    assert.match(blocked.blocked[0].reason!, /local test reason/);
    const exportPlan = await planMissingExports({ slugs: [f.slug], renderers: statuses });
    assert.equal(exportPlan.selected.length, 0);
    assert.match(exportPlan.invalid[0].reason, /local test reason/);
    await f.publish("after-effects");
    assert.equal(planContentPackageBatch(await packages([f.slug], statuses)).ready.length, 1);
    await updateTrackMetadata(f.slug, { title: "Changed while AE cannot run" });
    const stale = planContentPackageBatch(await packages([f.slug], statuses));
    assert.equal(stale.renderable.length, 0);
    assert.equal(stale.blocked.length, 1);
  });
}

test("AE delivery and auto-delivery copy the AE source, isolate receipts, and reject stale exports", async (t) => {
  const f = await setup(t, "after-effects");
  const settings = await destination(t);
  await f.publish("remotion");
  await f.publish("after-effects");
  const plan = await planDeliveries({ slugs: [f.slug], settings });
  assert.equal(plan.deliverable[0].engine, "after-effects");
  const result = await deliverPlanned(plan, settings);
  assert.equal(result.outcomes[0].status, "delivered");
  assert.equal(await fs.readFile(result.outcomes[0].destinationPath!, "utf8"), "after-effects video");
  assert.equal(readDeliveryReceipt(f.slug, "youtube-16x9"), null);
  assert.equal(readDeliveryReceipt(f.slug, "youtube-16x9", "after-effects")?.renderer, "after-effects");
  assert.equal((await planDeliveries({ slugs: [f.slug], settings })).alreadyDelivered.length, 1);
  assert.equal((await deliverAfterRender(f.slug, "youtube-16x9", undefined, "after-effects", settings))?.status, "delivered");
  await updateTrackMetadata(f.slug, { title: "Changed" });
  const stale = await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings });
  assert.equal(stale.status, "outdated");
  assert.equal(stale.reason, "export_not_current");
});

test("AE delivery refuses a switch to Remotion during staging, publishes nothing and leaves no receipt", async (t) => {
  const f = await setup(t, "after-effects");
  const settings = await destination(t);
  await f.publish("after-effects");
  await f.publish("remotion");
  const metadata = (await inspectTrack(f.slug)).metadata!;
  let changed = false;
  const original = childProcess.fork;
  t.mock.method(childProcess, "fork", (...args: Parameters<typeof childProcess.fork>) => {
    const child = original(...args);
    child.on("message", (message: { type?: string }) => {
      if (message.type === "staged") {
        writeFileSync(f.metadata, JSON.stringify({ ...metadata, renderer: "remotion" }));
        changed = true;
      }
    });
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings });
  assert.equal(changed, true);
  assert.equal(result.reason, "renderer_not_supported");
  assert.match(result.message!, /now prefers Remotion/);
  assert.deepEqual(await fs.readdir(settings.root), [f.slug]);
  assert.deepEqual(await fs.readdir(path.join(settings.root, f.slug)), [], "no video or staged copy survives");
  assert.equal(readDeliveryReceipt(f.slug, "youtube-16x9", "after-effects"), null);
});

test("Remotion-only catalogues keep legacy target and package shapes", async (t) => {
  const f = await setup(t);
  const plan = await planMissingExports({ slugs: [f.slug] });
  assert.deepEqual(toRenderTargets(plan), [{ slug: f.slug, preset: "youtube-16x9" }]);
  const pkg = (await packages([f.slug]))[0];
  assert.ok(pkg.found);
  if (pkg.found) {
    assert.equal("renderer" in pkg.package, false);
    assert.deepEqual(toRenderTargetsFromPlan(planContentPackageBatch([pkg])), [{ slug: f.slug, preset: "youtube-16x9" }]);
  }
  const view = toTrackSummaryView(await inspectTrack(f.slug));
  const input = { slug: f.slug, title: view.title, validationOk: true, metadata: null, exports: view.exports };
  assert.deepEqual(deriveContentPackage(input, { now: () => "test" }), deriveContentPackage({ ...input, renderer: "remotion" }, { now: () => "test" }));
});

test("content-package API queues AE targets and adopts only matching-engine jobs", async (t) => {
  const f = await setup(t, "after-effects");
  const dir = await fs.mkdtemp(path.join(tmpdir(), "ae-api-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const previous = { binary: process.env.TOSHI_AERENDER_PATH, config: process.env.TOSHI_AE_CONFIG };
  process.env.TOSHI_AERENDER_PATH = path.resolve("tests/fake-aerender.mjs");
  process.env.TOSHI_AE_CONFIG = path.join(dir, "config.json");
  await fs.writeFile(path.join(dir, "test.aep"), "test");
  await fs.writeFile(process.env.TOSHI_AE_CONFIG, JSON.stringify({ project: "test.aep", composition: "Track" }));
  t.after(() => {
    for (const [key, value] of [["TOSHI_AERENDER_PATH", previous.binary], ["TOSHI_AE_CONFIG", previous.config]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  });
  // Exercise the actual planning commands with an omitted engine, then an
  // explicit matching constraint. No command starts Adobe during inspection.
  for (const [script, args] of [
    ["render-missing", [f.slug, "--dry-run"]],
    ["content-package", [f.slug, "--json"]],
    ["content-package-batch", ["--track", f.slug, "--plan", "--json"]],
  ] as const) {
    for (const extra of [[], ["--engine", "after-effects"]]) {
      const result = childProcess.spawnSync(process.execPath, [`scripts/${script}.mts`, ...args, ...extra], { encoding: "utf8", timeout: 20_000 });
      assert.equal(result.status, 0, `${script}: ${result.stderr}`);
      assert.doesNotMatch(result.stdout, /Remotion exports only|not implemented/);
      if (script === "content-package-batch") assert.equal(JSON.parse(result.stdout).plan.renderable[0].engine, "after-effects");
    }
  }
  const workers: Worker[] = [];
  t.mock.method(childProcess, "fork", () => { const worker = new Worker(); worker.pid = 3456; workers.push(worker); return worker; });
  syncBuiltinESMExports();
  t.after(() => { for (const worker of workers) worker.emit("close", 1, null); t.mock.restoreAll(); syncBuiltinESMExports(); });
  const { handleRequest } = await import("../server/app.ts");
  const { renderManager } = await import("../services/workflows/renderManager.ts");
  const server = createServer((req, res) => { void handleRequest(req, res); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const apply = async () => {
    const response = await fetch(`${base}/api/content-package/batch/apply`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ tracks: [f.slug] }) });
    assert.equal(response.status, 200);
    return (await response.json()).data;
  };
  const first = await apply();
  assert.equal(first.renderBatch.jobs[0].engine, "after-effects");
  assert.equal(first.queued[0].engine, "after-effects");
  const adopted = await apply();
  assert.equal(adopted.jobReferences[0].jobId, first.renderBatch.jobs[0].id);
  const references = toSessionJobReferences(adopted.jobReferences);
  assert.equal(references[0].engine, "after-effects");
  // A different renderer can never match the restored reference.
  assert.equal(classifyRecoveredJob(references[0], { ...first.renderBatch.jobs[0], engine: "remotion" }), "mismatch");
  workers[0].emit("close", 1, null); await tick();
  const remotionJob = renderManager.startRender(f.slug, "youtube-16x9", "remotion");
  const conflict = await apply();
  assert.equal(conflict.adopted.length, 0);
  assert.equal(conflict.queued.length, 0);
  assert.equal(conflict.lockedElsewhere[0].engine, "after-effects");
  assert.ok(conflict.jobReferences.every((ref: { jobId: string | null }) => ref.jobId !== remotionJob.id));
});


test("catalogue-wide missing planning includes both engines without an override", async (t) => {
  const remotion = await setup(t);
  const ae = await setup(t, "after-effects");
  const plan = await planMissingExports({ renderers: READY });
  assert.equal(plan.catalogue, true);
  const own = toRenderTargets(plan).filter((target) => target.slug === remotion.slug || target.slug === ae.slug);
  assert.deepEqual(own.find((target) => target.slug === remotion.slug), { slug: remotion.slug, preset: "youtube-16x9" });
  assert.deepEqual(own.find((target) => target.slug === ae.slug), { slug: ae.slug, preset: "youtube-16x9", engine: "after-effects" });
});
