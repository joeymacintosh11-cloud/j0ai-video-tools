import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import fsPromises from "node:fs/promises";
import { chmodSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  applyDestinationFixPlan,
  planDestinationFix,
} from "../services/workflows/destinationFixPlan.ts";
import { renderManager } from "../services/workflows/renderManager.ts";
import { followRenderJob } from "../services/workflows/renderFollow.ts";
import { handleRenderEvents } from "../server/routes/renders.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import { DELIVERY_SETTINGS_FILE, type DeliverySettings } from "../services/delivery/deliverySettings.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import { scanDestinationHealth } from "../services/workflows/destinationHealth.ts";
import { Worker } from "./managerHarness.mts";
import { fixture } from "./fixtures.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

await isolateRenderJournalForThisFile();

/**
 * Confirmed delivery after a queued render: the wait-mode half of the fix
 * planner, which follows a render job through the *real* render manager to a
 * final, distinguished outcome instead of returning `queued` and hoping.
 *
 * The render manager is a module singleton (one render at a time, by
 * design), so these tests run against the real one rather than an isolated
 * copy: `child_process.fork` is mocked so no real Chromium runs, and every
 * test settles its own job to a terminal state before finishing so nothing
 * is left occupying the single render slot for a later test. A render
 * "succeeding" is simulated by calling `publishExport` directly — exactly
 * what a real render would leave behind — timed to the fake worker's own
 * "done" event, so delivery afterward sees a genuinely current export on
 * disk, not just a job the render manager happens to call completed.
 */

const destination = async (t: TestContext) => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "toshi-fixrender-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const settingsFor = (root: string | null): DeliverySettings => ({
  schemaVersion: 1,
  root,
  autoDeliver: false,
  autoUpdateReleaseBundle: false,
});

const setup = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const f = await fixture(t, extra);
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));

  const metadata = parseTrackMetadata(JSON.parse(await readFile(f.metadata, "utf8")), "fixture");
  const props = buildTrackProps({ slug: f.slug, metadata, analysisAvailable: true });

  const publish = (presetId: "youtube-16x9" | "vertical-9x16" = "youtube-16x9", body = "a finished video") =>
    publishExport(f.slug, presetId, fingerprintInputs(props, presetId), async (file) => {
      await writeFile(file, body);
    });

  const deliver = async (root: string, presetId: "youtube-16x9" | "vertical-9x16" = "youtube-16x9") => {
    const outcome = await deliverExport({ slug: f.slug, presetId, settings: settingsFor(root) });
    assert.equal(outcome.status, "delivered", outcome.message ?? "");
    return outcome;
  };

  return { ...f, metadata, props, publish, deliver };
};

/**
 * Delivers a preset, then breaks both the destination copy and the canonical
 * export — a receipt that says something was delivered, with nothing current
 * to redeliver, which is exactly what proposes a rerender_and_deliver action.
 */
const makeStaleDelivery = async (
  f: Awaited<ReturnType<typeof setup>>,
  root: string,
  presetId: "youtube-16x9" | "vertical-9x16" = "youtube-16x9",
) => {
  await f.publish(presetId);
  const outcome = await f.deliver(root, presetId);
  await rm(outcome.destinationPath!);
  await rm(trackOutputLocation(f.slug, presetId).path);
};

/**
 * Mocks `child_process.fork` for one test, using the real render manager
 * singleton — but only for the render worker. Delivery also forks its own
 * separate copy-worker process (`stageDelivery.ts`, for the same
 * cross-process-safe-copy reason renders use a lock); intercepting that one
 * too would make a genuine delivery attempt hang forever waiting on IPC from
 * a fake process that never replies, so every other fork call is passed
 * through to the real implementation, captured before mocking.
 */
const fakeRenderWorkers = (t: TestContext, spawn: () => Worker) => {
  const realFork = childProcess.fork.bind(childProcess);
  t.mock.method(childProcess, "fork", ((modulePath: unknown, ...rest: unknown[]) => {
    const isRenderWorker = String(modulePath).includes("render-worker");
    if (!isRenderWorker) {
      return (realFork as (...args: unknown[]) => ChildProcess)(modulePath, ...rest);
    }
    return spawn();
  }) as unknown as typeof childProcess.fork);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
};

// Bounded by wall-clock time, not iteration count: back-to-back setImmediate
// ticks with nothing else queued can burn through hundreds of iterations in
// under a millisecond, which is not a fair amount of real time for the
// production code's own genuine async work (a forked delivery-copy
// subprocess, a health scan) to interleave and complete.
const waitUntil = async (predicate: () => boolean, description: string, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${description}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
};

/** Settles any job still in flight, so a test never leaves the single render slot occupied. */
const settleAnyRemainingJob = (slug: string, presetId: string) => {
  const job = renderManager
    .listJobs()
    .find((j) => j.slug === slug && j.presetId === presetId && j.status !== "completed" && j.status !== "failed" && j.status !== "cancelled");
  if (job) {
    try {
      renderManager.cancelRender(job.id);
    } catch {
      // Already settling.
    }
  }
};

const action = (
  plan: Awaited<ReturnType<typeof planDestinationFix>>,
  kind: string,
  slug?: string | null,
) => plan.actions.find((a) => a.kind === kind && (slug === undefined || a.slug === slug));

/* ------------------------------------------------------------------ *
 * 1: happy path — queued -> rendering -> delivered -> bundle -> confirmed
 * ------------------------------------------------------------------ */

test("a rerender_and_deliver action followed with waitForCompletion reaches completed, updates the bundle, and confirms health", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);

  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9001;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;
  const bundle = action(plan, "regenerate_release_bundle", f.slug)!;

  const applyPromise = applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [rerender.id, bundle.id],
    waitForCompletion: true,
    timeoutMs: 5000,
  });

  await waitUntil(() => workers.length > 0, "a render job to be queued");
  // The fake worker settles as though it finished a real render: a real,
  // current export appears on disk, then the job reports done.
  await f.publish("youtube-16x9");
  workers[0].emit("message", { type: "resolved", durationInFrames: 1, fps: 30, outputPath: "x", outputLabel: "x" });
  workers[0].emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
  workers[0].emit("exit", 0, null);
  workers[0].emit("close", 0, null);

  const { results } = await applyPromise;
  const rerenderResult = results.find((r) => r.actionId === rerender.id)!;
  const bundleResult = results.find((r) => r.actionId === bundle.id)!;

  assert.equal(rerenderResult.status, "completed", JSON.stringify(rerenderResult));
  assert.ok(rerenderResult.jobId);
  assert.ok(rerenderResult.startedAt);
  assert.ok(rerenderResult.completedAt);
  assert.equal(rerenderResult.healthConfirmed, true);
  assert.equal(bundleResult.status, "completed", JSON.stringify(bundleResult));

  const health = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.equal(health.status, "healthy");
});

/* ------------------------------------------------------------------ *
 * 2: render fails -> render_failed, dependent bundle blocked
 * ------------------------------------------------------------------ */

test("a render that fails while being followed reports render_failed and blocks the dependent bundle action", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);

  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9002;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;
  const bundle = action(plan, "regenerate_release_bundle", f.slug)!;

  const applyPromise = applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [rerender.id, bundle.id],
    waitForCompletion: true,
    timeoutMs: 5000,
  });

  await waitUntil(() => workers.length > 0, "a render job to be queued");
  workers[0].emit("message", { type: "error", error: { code: "RENDER_FAILED", message: "Chromium crashed." } });
  workers[0].emit("exit", 1, null);
  workers[0].emit("close", 1, null);

  const { results } = await applyPromise;
  const rerenderResult = results.find((r) => r.actionId === rerender.id)!;
  const bundleResult = results.find((r) => r.actionId === bundle.id)!;

  assert.equal(rerenderResult.status, "render_failed");
  assert.match(rerenderResult.reason ?? "", /Chromium crashed/);
  assert.equal(bundleResult.status, "blocked");
});

/* ------------------------------------------------------------------ *
 * 3: render cancelled -> cancelled, never proceeds to delivery
 * ------------------------------------------------------------------ */

test("a render cancelled while being followed reports cancelled and never delivers", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);

  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9003;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;

  const applyPromise = applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [rerender.id],
    waitForCompletion: true,
    timeoutMs: 5000,
  });

  await waitUntil(() => workers.length > 0, "a render job to be queued");
  const jobId = renderManager.listJobs().find((j) => j.slug === f.slug)!.id;
  renderManager.cancelRender(jobId);
  workers[0].emit("exit", null, "SIGTERM");
  workers[0].emit("close", null, "SIGTERM");

  const { results } = await applyPromise;
  const rerenderResult = results.find((r) => r.actionId === rerender.id)!;

  assert.equal(rerenderResult.status, "cancelled");

  const facts = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  // Nothing delivered — the finding this action was for is still there.
  assert.equal(facts.status, "drift");
});

/* ------------------------------------------------------------------ *
 * 4: caller timeout never cancels the underlying job
 * ------------------------------------------------------------------ */

test("a timed-out wait never cancels the render, which can still complete afterward", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);

  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9004;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;

  const { results } = await applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [rerender.id],
    waitForCompletion: true,
    timeoutMs: 50, // Deliberately shorter than any real settle.
  });

  const rerenderResult = results.find((r) => r.actionId === rerender.id)!;
  assert.equal(rerenderResult.status, "timed_out");
  assert.ok(rerenderResult.jobId);

  // The job itself is untouched: still running, not cancelled — proven below
  // by letting it complete normally, which a cancelled job could never do.
  const job = renderManager.getJob(rerenderResult.jobId!);
  assert.notEqual(job.status, "cancelled");
  assert.ok(job.status === "preparing" || job.status === "rendering", job.status);

  // It can still complete on its own after the caller stopped waiting.
  await f.publish("youtube-16x9");
  workers[0].emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
  workers[0].emit("exit", 0, null);
  workers[0].emit("close", 0, null);
  await waitUntil(
    () => renderManager.getJob(rerenderResult.jobId!).status === "completed",
    "the render to finish after the caller stopped waiting",
  );

  const retry = await applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [rerender.id],
    waitForCompletion: true,
    timeoutMs: 5000,
    followJobs: [{ actionId: rerender.id, jobId: rerenderResult.jobId! }],
  });
  assert.equal(retry.results[0]?.status, "completed");
  assert.equal(retry.results[0]?.jobId, rerenderResult.jobId);
  assert.equal(workers.length, 1, "retry follows the original job instead of rendering again");
});

/* ------------------------------------------------------------------ *
 * 5: render succeeds, delivery fails
 * ------------------------------------------------------------------ */

test("a delivery that fails right after a successful followed render reports delivery_failed and keeps the new export", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);

  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9005;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;

  const applyPromise = applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [rerender.id],
    waitForCompletion: true,
    timeoutMs: 5000,
  });

  await waitUntil(() => workers.length > 0, "a render job to be queued");
  await f.publish("youtube-16x9");
  // Make the destination folder unwritable right before "done" fires, so the
  // copy itself fails once the render has genuinely finished.
  const trackFolder = path.join(root, f.slug);
  await mkdir(trackFolder, { recursive: true });
  chmodSync(trackFolder, 0o500);

  workers[0].emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
  workers[0].emit("exit", 0, null);
  workers[0].emit("close", 0, null);

  const { results } = await applyPromise;
  chmodSync(trackFolder, 0o700);

  const rerenderResult = results.find((r) => r.actionId === rerender.id)!;
  assert.equal(rerenderResult.status, "delivery_failed");

  // The newly rendered canonical export was never removed.
  const canonical = trackOutputLocation(f.slug, "youtube-16x9").path;
  await assert.doesNotReject(readFile(canonical));
});

/* ------------------------------------------------------------------ *
 * 6: two callers waiting on the same target converge on one job
 * ------------------------------------------------------------------ */

test("two concurrent apply calls for the same target adopt one render job, never two", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);

  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9006;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;

  const first = applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [rerender.id],
    waitForCompletion: true,
    timeoutMs: 5000,
  });
  const second = applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [rerender.id],
    waitForCompletion: true,
    timeoutMs: 5000,
  });

  await waitUntil(() => workers.length > 0, "a render job to be queued");
  // Only one worker was ever spawned for this one target.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(workers.length, 1, "a second concurrent apply call must not start a second render");

  await f.publish("youtube-16x9");
  workers[0].emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
  workers[0].emit("exit", 0, null);
  workers[0].emit("close", 0, null);

  const [firstResult, secondResult] = await Promise.all([first, second]);
  const a = firstResult.results.find((r) => r.actionId === rerender.id)!;
  const b = secondResult.results.find((r) => r.actionId === rerender.id)!;

  assert.equal(a.jobId, b.jobId);
  // Whichever copied first completes; the other, revalidating fresh, sees it
  // already delivered rather than racing a second copy.
  assert.ok(
    ["completed", "skipped_already_fixed", "delivery_failed"].includes(a.status),
    a.status,
  );
  assert.ok(
    ["completed", "skipped_already_fixed", "delivery_failed"].includes(b.status),
    b.status,
  );
  assert.ok(a.status === "completed" || b.status === "completed", "at least one caller must see it delivered");

  // Only the delivery was applied (no bundle action id was included), so the
  // destination is not fully "healthy" yet — a still-outdated release bundle
  // is expected and correct. What matters here is that the delivered file
  // itself is no longer drifted.
  const health = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  const track = health.tracks.find((entry) => entry.slug === f.slug);
  assert.ok(
    track!.findings.every((finding) => finding.code.startsWith("release_bundle_")),
    JSON.stringify(track!.findings),
  );
  const history = (await readFile(path.join(root, "delivery-log.jsonl"), "utf8")).trim().split("\n");
  assert.equal(history.length, 2, "initial delivery plus one remediation delivery");
});

/* ------------------------------------------------------------------ *
 * 8: two different presets correlate to two distinct jobs
 * ------------------------------------------------------------------ */

test("two different presets for the same track each follow their own distinct render job", async (t) => {
  const root = await destination(t);
  const f = await setup(t);

  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9100 + workers.length;
    workers.push(w);
    return w;
  });
  t.after(() => {
    settleAnyRemainingJob(f.slug, "youtube-16x9");
    settleAnyRemainingJob(f.slug, "vertical-9x16");
  });

  // Both presets get a real receipt, then both go stale, so the plan proposes
  // a rerender for each independently.
  await f.publish("youtube-16x9");
  const outcomeA = await f.deliver(root, "youtube-16x9");
  await rm(outcomeA.destinationPath!);
  await rm(trackOutputLocation(f.slug, "youtube-16x9").path);

  await f.publish("vertical-9x16");
  const outcomeB = await f.deliver(root, "vertical-9x16");
  await rm(outcomeB.destinationPath!);
  await rm(trackOutputLocation(f.slug, "vertical-9x16").path);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerenderActions = plan.actions.filter((a) => a.kind === "rerender_and_deliver" && a.slug === f.slug);
  assert.equal(rerenderActions.length, 2, JSON.stringify(plan.actions));

  const applyPromise = applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: rerenderActions.map((a) => a.id),
    waitForCompletion: true,
    timeoutMs: 5000,
  });

  // The settle loop processes these one at a time (the render manager only
  // ever runs one render at a time regardless), so each worker is settled in
  // turn — whichever preset is actually active is looked up rather than
  // assumed, since dependency/id ordering does not guarantee which runs first.
  for (let round = 0; round < 2; round += 1) {
    await waitUntil(() => workers.length > round, `render job ${round + 1} to be queued`);
    const activeJob = renderManager
      .listJobs()
      .find((j) => j.slug === f.slug && (j.status === "preparing" || j.status === "rendering"));
    assert.ok(activeJob, "expected an active render job");
    await f.publish(activeJob!.presetId as "youtube-16x9" | "vertical-9x16");
    const worker = workers[round]!;
    worker.emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
    worker.emit("exit", 0, null);
    worker.emit("close", 0, null);
  }

  const { results } = await applyPromise;
  const resultA = results.find((r) => r.actionId === rerenderActions[0]!.id)!;
  const resultB = results.find((r) => r.actionId === rerenderActions[1]!.id)!;

  assert.equal(resultA.status, "completed", JSON.stringify(resultA));
  assert.equal(resultB.status, "completed", JSON.stringify(resultB));
  assert.notEqual(resultA.jobId, resultB.jobId);
  assert.notEqual(resultA.presetId, resultB.presetId);
});

test("a terminal event at the subscribe boundary is recovered from manager state", async (t) => {
  for (const terminal of ["done", "error", "cancelled"] as const) {
    const workers: Worker[] = [];
    fakeRenderWorkers(t, () => {
      const w = new Worker();
      w.pid = 9200 + workers.length;
      workers.push(w);
      return w;
    });
    const job = renderManager.startRender(`zz-follow-${terminal}-${Date.now()}`);
    const subscribe = renderManager.subscribe.bind(renderManager);
    const mock = t.mock.method(renderManager, "subscribe", ((jobId: string, listener: Parameters<typeof renderManager.subscribe>[1]) => {
      const worker = workers[0]!;
      if (terminal === "done") worker.emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
      if (terminal === "error") worker.emit("message", { type: "error", error: { code: "RENDER_FAILED", message: "injected" } });
      if (terminal === "cancelled") worker.emit("message", { type: "cancelled" });
      return subscribe(jobId, listener);
    }) as typeof renderManager.subscribe);
    const result = await followRenderJob(job.id, 1000);
    assert.equal(result.outcome, "settled");
    assert.equal(result.job.status, terminal === "done" ? "completed" : terminal === "error" ? "failed" : "cancelled");
    mock.mock.restore();
    workers[0]!.emit("exit", 0, null);
    workers[0]!.emit("close", 0, null);
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("render SSE replays terminal state when completion lands at subscription", async (t) => {
  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9250;
    workers.push(w);
    return w;
  });
  const job = renderManager.startRender(`zz-sse-race-${Date.now()}`);
  const subscribe = renderManager.subscribe.bind(renderManager);
  t.mock.method(renderManager, "subscribe", ((jobId: string, listener: Parameters<typeof renderManager.subscribe>[1]) => {
    workers[0]!.emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
    return subscribe(jobId, listener);
  }) as typeof renderManager.subscribe);
  const chunks: string[] = [];
  let ended = false;
  const fake = Object.assign(new EventEmitter(), {
    writeHead: () => fake,
    write: (chunk: string) => { chunks.push(chunk); return true; },
    end: () => { ended = true; fake.emit("close"); },
  });
  Object.defineProperty(fake, "writableEnded", { get: () => ended });
  const response = fake as unknown as ServerResponse;
  handleRenderEvents(job.id, response);
  assert.match(chunks.join(""), /event: completed/);
  assert.equal(response.writableEnded, true);
  workers[0]!.emit("exit", 0, null);
  workers[0]!.emit("close", 0, null);
});

test("confirming a failed queued render reports that job without starting a replacement", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);
  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9301;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));
  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;
  const bundle = action(plan, "regenerate_release_bundle", f.slug)!;
  const actionIds = [rerender.id, bundle.id];
  const first = await applyDestinationFixPlan({ slugs: [f.slug], settings: settingsFor(root), actionIds });
  const jobId = first.results.find((r) => r.actionId === rerender.id)!.jobId!;
  workers[0]!.emit("message", { type: "error", error: { code: "RENDER_FAILED", message: "injected failure" } });
  workers[0]!.emit("exit", 1, null);
  workers[0]!.emit("close", 1, null);
  const confirmed = await applyDestinationFixPlan({
    slugs: [f.slug], settings: settingsFor(root), actionIds,
    waitForCompletion: true, followJobs: [{ actionId: rerender.id, jobId }],
  });
  assert.equal(confirmed.results.find((r) => r.actionId === rerender.id)!.status, "render_failed");
  assert.equal(confirmed.results.find((r) => r.actionId === bundle.id)!.status, "blocked");
  assert.equal(workers.length, 1);
});

test("confirming a completed job with no current export blocks delivery without rerendering", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);
  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9302;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));
  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;
  const first = await applyDestinationFixPlan({ slugs: [f.slug], settings: settingsFor(root), actionIds: [rerender.id] });
  const jobId = first.results[0]!.jobId!;
  workers[0]!.emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
  workers[0]!.emit("exit", 0, null);
  workers[0]!.emit("close", 0, null);
  const confirmed = await applyDestinationFixPlan({
    slugs: [f.slug], settings: settingsFor(root), actionIds: [rerender.id],
    waitForCompletion: true, followJobs: [{ actionId: rerender.id, jobId }],
  });
  assert.equal(confirmed.results[0]!.status, "blocked");
  assert.equal(workers.length, 1);
});

test("confirming the exact successful job survives rerender-to-redeliver reclassification", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);
  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9304;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));
  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;
  const bundle = action(plan, "regenerate_release_bundle", f.slug)!;
  const actionIds = [rerender.id, bundle.id];
  const first = await applyDestinationFixPlan({ slugs: [f.slug], settings: settingsFor(root), actionIds });
  const jobId = first.results.find((r) => r.actionId === rerender.id)!.jobId!;
  await f.publish();
  workers[0]!.emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
  workers[0]!.emit("exit", 0, null);
  workers[0]!.emit("close", 0, null);
  const confirmed = await applyDestinationFixPlan({
    slugs: [f.slug], settings: settingsFor(root), actionIds,
    waitForCompletion: true, followJobs: [{ actionId: rerender.id, jobId }],
  });
  const delivery = confirmed.results.find((r) => r.actionId === rerender.id)!;
  assert.equal(delivery.kind, "redeliver");
  assert.equal(delivery.status, "completed");
  assert.equal(delivery.healthConfirmed, true);
  assert.equal(confirmed.results.find((r) => r.actionId === bundle.id)!.status, "completed");
  assert.equal(workers.length, 1);
});

test("a changed live destination config blocks post-render delivery to the old root", async (t) => {
  const root = await destination(t);
  const replacementRoot = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);
  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9305;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));
  let configuredRoot = root;
  const realReadFile = fsPromises.readFile.bind(fsPromises);
  t.mock.method(fsPromises, "readFile", (async (...args: Parameters<typeof fsPromises.readFile>) => {
    if (String(args[0]) === DELIVERY_SETTINGS_FILE) {
      return JSON.stringify(settingsFor(configuredRoot));
    }
    return realReadFile(...args);
  }) as typeof fsPromises.readFile);
  syncBuiltinESMExports();
  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;
  const waiting = applyDestinationFixPlan({
    slugs: [f.slug], actionIds: [rerender.id], waitForCompletion: true, timeoutMs: 5000,
  });
  await waitUntil(() => workers.length > 0, "live-settings render job");
  await f.publish();
  configuredRoot = replacementRoot;
  workers[0]!.emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
  workers[0]!.emit("exit", 0, null);
  workers[0]!.emit("close", 0, null);
  const result = (await waiting).results[0]!;
  assert.equal(result.status, "blocked");
  assert.match(result.reason ?? "", /configured destination changed/);
  const health = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.ok(health.tracks[0]!.findings.some((finding) => finding.code === "delivered_file_missing"));
});

test("confirming a cancelled queued render never restarts it or delivers", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);
  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9306;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));
  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;
  const first = await applyDestinationFixPlan({ slugs: [f.slug], settings: settingsFor(root), actionIds: [rerender.id] });
  const jobId = first.results[0]!.jobId!;
  renderManager.cancelRender(jobId);
  workers[0]!.emit("exit", null, "SIGTERM");
  workers[0]!.emit("close", null, "SIGTERM");
  const confirmed = await applyDestinationFixPlan({
    slugs: [f.slug], settings: settingsFor(root), actionIds: [rerender.id],
    waitForCompletion: true, followJobs: [{ actionId: rerender.id, jobId }],
  });
  assert.equal(confirmed.results[0]!.status, "cancelled");
  assert.equal(workers.length, 1);
  assert.ok((await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) })).tracks[0]!
    .findings.some((finding) => finding.code === "delivered_file_missing"));
});

test("a confirm call refuses a job belonging to another target", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);
  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9307;
    workers.push(w);
    return w;
  });
  const wrongJob = renderManager.startRender(`zz-other-${Date.now()}`);
  workers[0]!.emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
  workers[0]!.emit("exit", 0, null);
  workers[0]!.emit("close", 0, null);
  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;
  const result = await applyDestinationFixPlan({
    slugs: [f.slug], settings: settingsFor(root), actionIds: [rerender.id],
    waitForCompletion: true, followJobs: [{ actionId: rerender.id, jobId: wrongJob.id }],
  });
  assert.equal(result.results[0]!.status, "blocked");
  assert.match(result.results[0]!.reason ?? "", /does not belong/);
  assert.equal(workers.length, 1);
});

test("a successful delivery remains unconfirmed while an unexpected file is present", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await makeStaleDelivery(f, root);
  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9308;
    workers.push(w);
    return w;
  });
  t.after(() => settleAnyRemainingJob(f.slug, "youtube-16x9"));
  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const rerender = action(plan, "rerender_and_deliver", f.slug)!;
  const bundle = action(plan, "regenerate_release_bundle", f.slug)!;
  const pending = applyDestinationFixPlan({
    slugs: [f.slug], settings: settingsFor(root), actionIds: [rerender.id, bundle.id],
    waitForCompletion: true, timeoutMs: 5000,
  });
  await waitUntil(() => workers.length > 0, "render before manual drift probe");
  await f.publish();
  await writeFile(path.join(root, f.slug, `${f.slug}-old-preset.mp4`), "manual file");
  workers[0]!.emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
  workers[0]!.emit("exit", 0, null);
  workers[0]!.emit("close", 0, null);
  const result = (await pending).results.find((entry) => entry.actionId === rerender.id)!;
  assert.equal(result.status, "completed");
  assert.equal(result.healthConfirmed, false);
});

test("many render followers release listeners after timeout and completion", async (t) => {
  const workers: Worker[] = [];
  fakeRenderWorkers(t, () => {
    const w = new Worker();
    w.pid = 9303;
    workers.push(w);
    return w;
  });
  const job = renderManager.startRender(`zz-follow-stress-${Date.now()}`);
  const subscribe = renderManager.subscribe.bind(renderManager);
  let active = 0;
  t.mock.method(renderManager, "subscribe", ((jobId: string, listener: Parameters<typeof renderManager.subscribe>[1]) => {
    active++;
    const unsubscribe = subscribe(jobId, listener);
    return () => { active--; unsubscribe(); };
  }) as typeof renderManager.subscribe);
  const full = Array.from({ length: 20 }, () => followRenderJob(job.id, 5000));
  const short = Array.from({ length: 20 }, () => followRenderJob(job.id, 5));
  const timed = await Promise.all(short);
  assert.ok(timed.every((result) => result.outcome === "timed_out"));
  assert.equal(active, 20);
  workers[0]!.emit("message", { type: "done", outputPath: "x", outputLabel: "x" });
  workers[0]!.emit("exit", 0, null);
  workers[0]!.emit("close", 0, null);
  const settled = await Promise.all(full);
  assert.ok(settled.every((result) => result.outcome === "settled" && result.job.status === "completed"));
  assert.equal(active, 0);
});
