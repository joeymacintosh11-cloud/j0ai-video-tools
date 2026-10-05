import { fork, type ForkOptions } from "node:child_process";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import { fixture } from "./fixtures.mts";
import { manager, type Manager, type Worker } from "./managerHarness.mts";
import { workflowWorker } from "./productionWorkflowHarness.mts";
import { syntheticTemplate } from "./syntheticTemplate.mts";
import { readDeliverySettings } from "../services/delivery/deliverySettings.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import { readDeliveryReceipt } from "../services/delivery/deliveryReceipt.ts";
import {
  queryDeliveryHistory,
  reconcileDeliveryHistory,
} from "../services/workflows/deliveryHistory.ts";
import { scanDestinationHealth } from "../services/workflows/destinationHealth.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import {
  planMissingExports,
  toRenderTargets,
} from "../services/workflows/exportPlan.ts";
import {
  buildContentPackagesForSlugs,
  planContentPackageBatch,
} from "../services/workflows/contentPackagePlan.ts";
import { readContentLibrary } from "../services/library/contentLibraryLog.ts";
import { registerTemplateIdentityReader } from "../services/render/templateIdentity.ts";
import {
  getHistoricalRenderJob,
  waitForRenderJournalIdle,
} from "../services/workflows/renderJournal.ts";
import { inspectRenderTargetLock } from "../services/render/renderLock.ts";
import { activeRenderFor } from "../ui/components/engineModel.ts";
import {
  toSessionJobReferences,
  classifyRecoveredJob,
} from "../ui/batchSession.ts";
import type { RendererId } from "../core/domain/video/renderers.ts";
import type { RenderJobView } from "../core/domain/api/views.ts";

const formats = ["youtube-16x9", "vertical-9x16", "square-1x1"] as const;
const ready = ["remotion", "after-effects"].map((id) => ({
  id: id as RendererId,
  implemented: true,
  state: "ready" as const,
  problem: null,
}));
const realFork = fork;
const spawnWorkflow = (
  module: string,
  args: readonly string[],
  options = {},
  forkOptions?: ForkOptions,
) =>
  String(module).endsWith("render-worker.mts")
    ? workflowWorker(args, options)
    : (realFork(module, [...args], forkOptions) as unknown as Worker);
const packages = (slugs: string[]) =>
  buildContentPackagesForSlugs(slugs, {
    inFlight: new Map(),
    deliveryRoot: null,
    globalTemplates: null,
    templatesProblem: null,
    renderers: ready,
  });
const waitUntil = async (check: () => boolean) => {
  const deadline = Date.now() + 10000;
  while (!check()) {
    assert.ok(Date.now() < deadline, "workflow did not settle");
    await delay(5);
  }
};
const settle = async (m: Manager) => {
  await waitUntil(() =>
    m
      .listJobs()
      .every((j) => ["completed", "failed", "cancelled"].includes(j.status)),
  );
  await waitForRenderJournalIdle();
};
const setup = async (t: TestContext) => {
  assert.equal(
    (await readDeliverySettings()).autoDeliver,
    false,
    "synthetic tests require local automatic delivery off",
  );
  const dir = realpathSync(
    await mkdtemp(path.join(tmpdir(), "production-workflow-")),
  );
  const before = process.env.TOSHI_CONTENT_LIBRARY_DIR;
  process.env.TOSHI_CONTENT_LIBRARY_DIR = path.join(dir, "library");
  t.after(async () => {
    if (before === undefined) delete process.env.TOSHI_CONTENT_LIBRARY_DIR;
    else process.env.TOSHI_CONTENT_LIBRARY_DIR = before;
    await rm(dir, { recursive: true, force: true });
  });
  const template = await syntheticTemplate(t);
  const track = async (renderer?: RendererId) => {
    const f = await fixture(t, {
      ...(renderer ? { renderer } : {}),
      exportPresets: formats,
    });
    await writeFile(f.cover, "synthetic cover");
    await writeFile(f.beat, "synthetic audio");
    t.after(() => rm(f.outputDir, { recursive: true, force: true }));
    return f;
  };
  return { dir, template, track };
};

for (const engines of [
  ["remotion"],
  ["after-effects"],
  ["remotion", "after-effects"],
] as const) {
  test(`${engines.join(" + ")}: planned multi-format queue → publication → freshness → package → delivery/history → reload`, async (t) => {
    const c = await setup(t);
    // Omitted renderer models a pre-V2 Remotion track.
    const tracks = await Promise.all(
      engines.map((e) => c.track(e === "remotion" ? undefined : e)),
    );
    const slugs = tracks.map((f) => f.slug);
    const m = await manager(t, (module, args, forkOptions) =>
      spawnWorkflow(module, args, {}, forkOptions),
    );
    const plan = await planMissingExports({ slugs, renderers: ready });
    const targets = toRenderTargets(plan);
    assert.equal(targets.length, engines.length * 3);
    const { batch } = m.startBatch([...targets, targets[0]]);
    assert.equal(batch.totalJobs, targets.length);
    assert.equal(
      m.startBatch(targets).skipped.length,
      targets.length,
      "double-submit adds no jobs",
    );
    assert.equal(batch.active, 1, "both engines use the serial worker slot");
    assert.deepEqual(
      batch.jobs.map((j) => j.engine),
      targets.map((target) => target.engine ?? "remotion"),
    );
    await settle(m);
    assert.equal(m.getBatch(batch.id).completed, targets.length);
    assert.equal(m.inFlightExports().size, 0);
    for (let i = 0; i < tracks.length; i++) {
      const f = tracks[i],
        engine = engines[i];
      const reloaded = await inspectTrack(f.slug);
      assert.deepEqual(reloaded.metadata?.exportPresets, formats);
      assert.equal(reloaded.metadata?.renderer ?? "remotion", engine);
      assert.ok(
        trackExportCoverage(f.slug, undefined, engine).every(
          (entry) => entry.freshness === "current",
        ),
      );
      const records = readContentLibrary().records.filter(
        (entry) => entry.track.slug === f.slug,
      );
      assert.equal(records.length, 3);
      assert.ok(records.every((entry) => entry.template.renderer === engine));
      const settings = {
        schemaVersion: 1,
        root: c.dir,
        autoDeliver: false,
        autoUpdateReleaseBundle: false,
      };
      for (const presetId of formats) {
        const output = trackOutputLocation(f.slug, presetId, engine);
        assert.equal(
          await readFile(output.path, "utf8"),
          `${engine}:${f.slug}:${presetId}`,
        );
        const delivered = await deliverExport({
          slug: f.slug,
          presetId,
          settings,
        });
        assert.equal(delivered.status, "delivered", delivered.message ?? "");
        assert.equal(
          await readFile(delivered.destinationPath!, "utf8"),
          `${engine}:${f.slug}:${presetId}`,
        );
        assert.equal(
          readDeliveryReceipt(f.slug, presetId, engine)?.renderer ?? "remotion",
          engine,
        );
        assert.equal(
          (await deliverExport({ slug: f.slug, presetId, settings })).status,
          "delivered",
        );
      }
      const reconciled = await reconcileDeliveryHistory({ settings });
      assert.equal(reconciled.appended.length, 0);
      const history = await queryDeliveryHistory({
        settings,
        filter: { track: f.slug },
      });
      assert.equal(
        history.events.length,
        6,
        "explicit repeated delivery is recorded; reconciliation adds no duplicate",
      );
      const health = await scanDestinationHealth({ settings, slugs: [f.slug] });
      assert.ok(
        health.tracks[0].findings.every(
          (finding) => finding.code === "release_bundle_missing",
        ),
      );
      assert.ok(
        (
          await readdir(trackOutputLocation(f.slug, formats[0], engine).dir)
        ).every((file) => !file.startsWith(".render-")),
      );
    }
    assert.equal(
      planContentPackageBatch(await packages(slugs)).ready.length,
      tracks.length * 3,
    );
    assert.equal(
      (await planMissingExports({ slugs, renderers: ready })).selected.length,
      0,
    );
    for (const job of m.getBatch(batch.id).jobs) {
      assert.equal(getHistoricalRenderJob(job.id)?.status, "completed");
      assert.equal(getHistoricalRenderJob(job.id)?.engine, job.engine);
      const [reference] = toSessionJobReferences([
        {
          slug: job.slug,
          presetId: job.presetId,
          engine: job.engine!,
          jobId: job.id,
          platformId:
            job.presetId === "youtube-16x9"
              ? "youtube"
              : job.presetId === "vertical-9x16"
                ? "reels"
                : "instagram-square",
          actionId: `${job.slug}::${job.presetId === "youtube-16x9" ? "youtube" : job.presetId === "vertical-9x16" ? "reels" : "instagram-square"}::${job.presetId}${job.engine === "remotion" ? "" : `::${job.engine}`}`,
          outcome: "queued",
        },
      ]);
      assert.equal(classifyRecoveredJob(reference, job), "terminal");
    }
  });
}

for (const engine of ["remotion", "after-effects"] as const) {
  test(`${engine}: failure and cancellation preserve prior exports; retry clears stale package state`, async (t) => {
    const c = await setup(t),
      f = await c.track(engine);
    await updateTrackMetadata(f.slug, { exportPresets: [formats[0]] });
    let mode: "success" | "failure" = "failure";
    const m = await manager(t, (module, args, forkOptions) =>
      spawnWorkflow(module, args, { mode, delayMs: 40 }, forkOptions),
    );
    m.startRender(f.slug, formats[0], engine);
    await settle(m);
    assert.equal(m.listJobs()[0].status, "failed");
    assert.equal(
      planContentPackageBatch(await packages([f.slug])).ready.length,
      0,
    );
    assert.equal(
      trackExportCoverage(f.slug, undefined, engine)[0].freshness,
      "missing",
    );
    mode = "success";
    m.startRender(f.slug, formats[0], engine);
    await settle(m);
    const output = trackOutputLocation(f.slug, formats[0], engine);
    const bytes = await readFile(output.path),
      manifest = await readFile(output.manifest);
    await updateTrackMetadata(f.slug, { bpm: 123 });
    mode = "failure";
    m.startRender(f.slug, formats[0], engine);
    await settle(m);
    assert.deepEqual(await readFile(output.path), bytes);
    assert.deepEqual(await readFile(output.manifest), manifest);
    mode = "success";
    const cancelled = m.startRender(f.slug, formats[0], engine);
    await waitUntil(() => m.getJob(cancelled.id).status === "rendering");
    m.cancelRender(cancelled.id);
    m.cancelRender(cancelled.id);
    await settle(m);
    assert.equal(m.getJob(cancelled.id).status, "cancelled");
    assert.deepEqual(await readFile(output.path), bytes);
    assert.equal(inspectRenderTargetLock(f.slug, formats[0]).state, "free");
    assert.equal(
      planContentPackageBatch(await packages([f.slug])).renderable[0].kind,
      "rerender_stale",
    );
    m.startRender(f.slug, formats[0], engine);
    await settle(m);
    assert.equal(
      planContentPackageBatch(await packages([f.slug])).ready.length,
      1,
    );
    assert.equal(
      readContentLibrary().records.filter(
        (record) => record.track.slug === f.slug,
      ).length,
      2,
    );
  });
}

test("renderer/template changes isolate stale planning, queue adoption and delivery", async (t) => {
  const c = await setup(t),
    remotion = await c.track(),
    ae = await c.track("after-effects");
  const m = await manager(t, (module, args, forkOptions) =>
    spawnWorkflow(module, args, { delayMs: 40 }, forkOptions),
  );
  const slugs = [remotion.slug, ae.slug];
  m.startBatch(
    toRenderTargets(await planMissingExports({ slugs, renderers: ready })),
  );
  await settle(m);
  const restore = registerTemplateIdentityReader("after-effects", () => ({
    template: { ...c.template, version: "new-template-version" },
    problem: null,
  }));
  t.after(restore);
  const stale = await planMissingExports({
    slugs,
    mode: "stale",
    renderers: ready,
  });
  assert.equal(stale.selected.length, 3);
  assert.ok(
    stale.selected.every(
      (target) => target.slug === ae.slug && target.engine === "after-effects",
    ),
  );
  m.startBatch(toRenderTargets(stale));
  await settle(m);
  assert.equal(planContentPackageBatch(await packages(slugs)).ready.length, 6);
  const job = m.startRender(remotion.slug, formats[0], "remotion");
  assert.equal(
    activeRenderFor(m.listJobs(), remotion.slug, "remotion")?.id,
    job.id,
  );
  await updateTrackMetadata(remotion.slug, { renderer: "after-effects" });
  assert.equal(
    activeRenderFor(m.listJobs(), remotion.slug, "after-effects"),
    undefined,
    "reload cannot adopt another engine's job",
  );
  assert.equal(
    activeRenderFor(m.listJobs(), remotion.slug, "remotion", "square-1x1"),
    undefined,
  );
  assert.throws(
    () => m.startRender(remotion.slug, formats[0], "after-effects"),
    /already rendering/,
  );
  await settle(m);
  assert.equal(
    (await planMissingExports({ slugs: [remotion.slug], renderers: ready }))
      .selected.length,
    3,
  );
  const settings = {
    schemaVersion: 1,
    root: c.dir,
    autoDeliver: false,
    autoUpdateReleaseBundle: false,
  };
  assert.equal(
    (
      await deliverExport({
        slug: remotion.slug,
        presetId: formats[0],
        settings,
      })
    ).reason,
    "export_missing",
  );
  assert.equal(
    activeRenderFor(
      [{ ...job, status: "interrupted" } as RenderJobView],
      remotion.slug,
      "remotion",
    ),
    undefined,
  );
});

test("cancelling an AE job drains queued Remotion work without cross-engine status or publication", async (t) => {
  const c = await setup(t),
    ae = await c.track("after-effects"),
    remotion = await c.track();
  const m = await manager(t, (module, args, forkOptions) =>
    spawnWorkflow(module, args, { delayMs: 40 }, forkOptions),
  );
  const { batch } = m.startBatch([
    { slug: ae.slug, preset: formats[0], engine: "after-effects" },
    { slug: remotion.slug, preset: formats[0] },
  ]);
  await waitUntil(() => m.getJob(batch.jobs[0].id).status === "rendering");
  m.cancelRender(batch.jobs[0].id);
  await settle(m);
  assert.equal(m.getBatch(batch.id).cancelled, 1);
  assert.equal(m.getBatch(batch.id).completed, 1);
  assert.equal(
    trackExportCoverage(ae.slug, undefined, "after-effects")[0].freshness,
    "missing",
  );
  assert.equal(trackExportCoverage(remotion.slug)[0].freshness, "current");
  assert.equal(m.inFlightExports().size, 0);
});

test("source edits stale only the affected track; intended format changes select missing formats", async (t) => {
  const c = await setup(t),
    a = await c.track("after-effects"),
    b = await c.track();
  await updateTrackMetadata(a.slug, { exportPresets: [formats[0]] });
  const m = await manager(t, (module, args, forkOptions) =>
    spawnWorkflow(module, args, {}, forkOptions),
  );
  const slugs = [a.slug, b.slug];
  m.startBatch(
    toRenderTargets(await planMissingExports({ slugs, renderers: ready })),
  );
  await settle(m);
  for (const asset of [a.cover, a.beat]) {
    await writeFile(asset, `changed ${asset}`);
    const plan = await planMissingExports({
      slugs,
      mode: "stale",
      renderers: ready,
    });
    assert.equal(plan.selected.length, 1);
    assert.equal(plan.selected[0].slug, a.slug);
    assert.equal(plan.selected[0].engine, "after-effects");
    m.startBatch(toRenderTargets(plan));
    await settle(m);
    assert.equal(
      trackExportCoverage(a.slug, undefined, "after-effects")[0].freshness,
      "current",
    );
    assert.ok(
      trackExportCoverage(b.slug).every(
        (entry) => entry.freshness === "current",
      ),
    );
  }
  await updateTrackMetadata(a.slug, { exportPresets: formats });
  const missing = await planMissingExports({ slugs, renderers: ready });
  assert.deepEqual(
    missing.selected.map((target) => target.presetId),
    [formats[1], formats[2]],
  );
  assert.ok(
    missing.selected.every((target) => target.engine === "after-effects"),
  );
});
