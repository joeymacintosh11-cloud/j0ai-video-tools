import assert from "node:assert/strict";
import test from "node:test";
import { managerWithWorkers, tick } from "./managerHarness.mts";

/**
 * Batch queue behaviour.
 *
 * These drive the manager with stand-in workers, so every ordering — a failure
 * mid-batch, a cancellation, an overlapping request — is covered without
 * spending three minutes per render.
 */

const settle = async (worker: { emit: (event: string, ...args: unknown[]) => boolean }) => {
  worker.emit("exit", 0, null);
  worker.emit("close", 0, null);
  await tick();
};

test("a batch queues its targets in the given order, one active at a time", async (t) => {
  const { manager } = await managerWithWorkers(t);

  const { batch } = manager.startBatch([
    { slug: "alpha", preset: "youtube-16x9" },
    { slug: "alpha", preset: "vertical-9x16" },
    { slug: "bravo", preset: "square-1x1" },
  ]);

  assert.equal(batch.totalJobs, 3);
  assert.deepEqual(
    batch.jobs.map((job) => [job.slug, job.presetId]),
    [
      ["alpha", "youtube-16x9"],
      ["alpha", "vertical-9x16"],
      ["bravo", "square-1x1"],
    ],
  );

  // Exactly one render runs; the rest wait.
  assert.equal(batch.active, 1);
  assert.equal(batch.queued, 2);
  assert.equal(batch.status, "running");
  assert.equal(batch.jobs[0].status, "preparing");
  assert.equal(batch.jobs[0].batchId, batch.id);
});

test("several formats of one track all queue; a repeated pair does not", async (t) => {
  const { manager } = await managerWithWorkers(t);

  const { batch, skipped } = manager.startBatch([
    { slug: "alpha", preset: "youtube-16x9" },
    { slug: "alpha", preset: "square-1x1" },
    { slug: "alpha", preset: "youtube-16x9" },
  ]);

  assert.equal(batch.totalJobs, 2);
  assert.deepEqual(skipped, [{ slug: "alpha", preset: "youtube-16x9" }]);
});

test("a batch skips pairs already in flight rather than failing outright", async (t) => {
  const { manager } = await managerWithWorkers(t);

  manager.startRender("alpha", "youtube-16x9");

  const { batch, skipped } = manager.startBatch([
    { slug: "alpha", preset: "youtube-16x9" },
    { slug: "alpha", preset: "vertical-9x16" },
  ]);

  assert.deepEqual(skipped, [{ slug: "alpha", preset: "youtube-16x9" }]);
  assert.equal(batch.totalJobs, 1);
  assert.equal(batch.jobs[0].presetId, "vertical-9x16");
});

test("an invalid target rejects the whole request without queueing anything", async (t) => {
  const { manager } = await managerWithWorkers(t);

  assert.throws(
    () =>
      manager.startBatch([
        { slug: "alpha", preset: "youtube-16x9" },
        { slug: "alpha", preset: "tiktok-portrait" as never },
      ]),
    { code: "INVALID_PRESET" },
  );

  assert.throws(
    () => manager.startBatch([{ slug: "../etc", preset: "youtube-16x9" }]),
    { code: "INVALID_SLUG" },
  );

  // Nothing from either attempt was queued.
  assert.equal(manager.listJobs().length, 0);
  assert.equal(manager.listBatches().length, 0);
});

test("an empty batch is refused", async (t) => {
  const { manager } = await managerWithWorkers(t);

  assert.throws(() => manager.startBatch([]), { code: "INVALID_REQUEST" });
});

test("a failed job does not stop the batch: the next one starts", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  const { batch } = manager.startBatch([
    { slug: "alpha", preset: "youtube-16x9" },
    { slug: "alpha", preset: "vertical-9x16" },
  ]);

  workers[0].emit("message", {
    type: "error",
    error: { code: "RENDER_FAILED", message: "boom" },
  });
  await settle(workers[0]);

  const after = manager.getBatch(batch.id);
  assert.equal(after.failed, 1);
  assert.equal(after.jobs[1].status, "preparing");
  assert.equal(after.status, "running");
});

test("a cancelled job does not stop the batch either", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  const { batch } = manager.startBatch([
    { slug: "alpha", preset: "youtube-16x9" },
    { slug: "alpha", preset: "vertical-9x16" },
  ]);

  manager.cancelRender(batch.jobs[0].id);
  await settle(workers[0]);

  const after = manager.getBatch(batch.id);
  assert.equal(after.cancelled, 1);
  assert.equal(after.jobs[1].status, "preparing");
});

test("an exact queued job can be cancelled without starting its worker or its siblings", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);
  const outsider = manager.startRender("outside", "youtube-16x9");
  const { batch } = manager.startBatch([
    { slug: "alpha", preset: "youtube-16x9" },
    { slug: "bravo", preset: "vertical-9x16" },
  ]);

  assert.equal(batch.jobs[0]!.status, "queued");
  assert.equal(batch.jobs[1]!.status, "queued");
  assert.equal(manager.cancelRender(batch.jobs[1]!.id).status, "cancelled");
  assert.equal(manager.getJob(outsider.id).status, "preparing");
  assert.equal(manager.getJob(batch.jobs[0]!.id).status, "queued");
  assert.equal(workers.length, 1, "no worker was created for the cancelled queued job");

  manager.cancelRender(batch.jobs[0]!.id);
  manager.cancelRender(outsider.id);
  workers[0]!.emit("message", { type: "cancelled" });
  await settle(workers[0]!);
});

test("cancelling a batch stops all of its unsettled jobs and nothing else", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  // An unrelated single render must survive the batch cancellation.
  const outsider = manager.startRender("zulu", "youtube-16x9");

  const { batch } = manager.startBatch([
    { slug: "alpha", preset: "youtube-16x9" },
    { slug: "alpha", preset: "vertical-9x16" },
    { slug: "alpha", preset: "square-1x1" },
  ]);

  const cancelled = manager.cancelBatch(batch.id);

  assert.equal(cancelled.cancelled, 3);
  assert.equal(manager.getJob(outsider.id).status, "preparing");

  await settle(workers[0]);
  assert.equal(manager.getBatch(batch.id).status, "finished");
});

test("cancelling an already finished batch is not an error", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  const { batch } = manager.startBatch([{ slug: "alpha", preset: "square-1x1" }]);

  manager.cancelBatch(batch.id);
  await settle(workers[0]);

  const again = manager.cancelBatch(batch.id);
  assert.equal(again.status, "finished");
  assert.equal(again.cancelled, 1);
});

test("batch progress is the mean of real job progress, not a guess", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  const { batch } = manager.startBatch([
    { slug: "alpha", preset: "youtube-16x9" },
    { slug: "alpha", preset: "vertical-9x16" },
  ]);

  assert.equal(manager.getBatch(batch.id).progress, 0);

  // Half of the first job is a quarter of a two-job batch.
  workers[0].emit("message", {
    type: "progress",
    progress: 0.5,
    renderedFrames: 100,
    encodedFrames: 100,
    stitchStage: "encoding",
  });
  assert.equal(manager.getBatch(batch.id).progress, 0.25);

  // A completed job counts as a whole one.
  workers[0].emit("message", {
    type: "done",
    outputPath: "/unused",
    outputLabel: "out/alpha/youtube-16x9.mp4",
  });
  await settle(workers[0]);
  assert.equal(manager.getBatch(batch.id).progress, 0.5);
  assert.equal(manager.getBatch(batch.id).completed, 1);
});

test("a batch with a failure settles below 100% rather than pretending", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  const { batch } = manager.startBatch([{ slug: "alpha", preset: "square-1x1" }]);

  workers[0].emit("message", {
    type: "progress",
    progress: 0.4,
    renderedFrames: 10,
    encodedFrames: 10,
    stitchStage: "rendering",
  });
  workers[0].emit("message", {
    type: "error",
    error: { code: "RENDER_FAILED", message: "disk full" },
  });
  await settle(workers[0]);

  const after = manager.getBatch(batch.id);
  assert.equal(after.status, "finished");
  assert.equal(after.settled, 1);
  assert.ok(after.progress < 1, "progress reflects where it actually stopped");
  assert.equal(after.progress, 0.4);
});

test("batch subscribers stop being called once they unsubscribe", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  const { batch } = manager.startBatch([
    { slug: "alpha", preset: "youtube-16x9" },
    { slug: "alpha", preset: "vertical-9x16" },
  ]);

  let updates = 0;
  const unsubscribe = manager.subscribeBatch(batch.id, () => {
    updates += 1;
  });

  workers[0].emit("message", {
    type: "progress",
    progress: 0.2,
    renderedFrames: 5,
    encodedFrames: 5,
    stitchStage: "rendering",
  });
  assert.ok(updates > 0, "a live subscriber hears about progress");

  const seen = updates;
  unsubscribe();

  workers[0].emit("message", {
    type: "progress",
    progress: 0.6,
    renderedFrames: 9,
    encodedFrames: 9,
    stitchStage: "rendering",
  });
  assert.equal(updates, seen, "no further calls after unsubscribing");

  await settle(workers[0]);
});

test("an unknown batch id is reported as not found", async (t) => {
  const { manager } = await managerWithWorkers(t);

  assert.throws(() => manager.getBatch("nope"), {
    code: "RENDER_BATCH_NOT_FOUND",
  });
  assert.throws(() => manager.cancelBatch("nope"), {
    code: "RENDER_BATCH_NOT_FOUND",
  });
});

test("a single render still works with no preset named, and reports the default", async (t) => {
  const { manager } = await managerWithWorkers(t);

  const job = manager.startRender("alpha");

  assert.equal(job.presetId, "youtube-16x9");
  assert.equal(job.batchId, null);
});
