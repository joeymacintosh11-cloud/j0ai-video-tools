import assert from "node:assert/strict";
import test from "node:test";
import { managerWithWorkers, tick } from "./managerHarness.mts";

/**
 * In-memory history retention.
 *
 * Job and batch records are never written to disk, so a long-lived server would
 * otherwise accumulate them forever. Only settled records are ever dropped, and
 * rendered files on disk are untouched either way.
 */

const settle = async (worker: {
  emit: (event: string, ...args: unknown[]) => boolean;
}) => {
  worker.emit("exit", 0, null);
  worker.emit("close", 0, null);
  await tick();
};

/** Runs one render for a distinct track to completion. */
const runOne = async (
  manager: Awaited<ReturnType<typeof managerWithWorkers>>["manager"],
  workers: Awaited<ReturnType<typeof managerWithWorkers>>["workers"],
  index: number,
) => {
  const job = manager.startRender(`track-${index}`, "youtube-16x9");
  const worker = workers[workers.length - 1];

  worker.emit("message", {
    type: "done",
    outputPath: "/unused",
    outputLabel: `out/track-${index}/youtube-16x9.mp4`,
  });
  await settle(worker);

  return job;
};

test("settled jobs are trimmed once history grows past its bound", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  // Comfortably past the 200-job bound.
  for (let i = 0; i < 230; i += 1) {
    await runOne(manager, workers, i);
  }

  const jobs = manager.listJobs();
  assert.ok(jobs.length <= 200, `kept ${jobs.length} jobs, expected at most 200`);
  assert.ok(jobs.length >= 190, "the bound trims rather than emptying history");

  // The survivors are the most recent ones.
  const slugs = new Set(jobs.map((job) => job.slug));
  assert.ok(slugs.has("track-229"), "the newest job is kept");
  assert.ok(!slugs.has("track-0"), "the oldest job is dropped");
});

test("queued and running jobs are never trimmed", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  // One render takes the slot and one waits; neither may be dropped however
  // much settled history piles up behind them.
  const active = manager.startRender("held-active", "youtube-16x9");
  const queued = manager.startRender("held-queued", "youtube-16x9");

  for (let i = 0; i < 230; i += 1) {
    const job = manager.startRender(`filler-${i}`, "square-1x1");
    const worker = workers[workers.length - 1];
    // Filler jobs are queued behind the held ones, so cancel them to settle.
    manager.cancelRender(job.id);
    if (worker) {
      await tick();
    }
  }

  assert.equal(manager.getJob(active.id).status, "preparing");
  assert.equal(manager.getJob(queued.id).status, "queued");
});

test("a retained batch can still list every one of its jobs", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  const { batch } = manager.startBatch([
    { slug: "kept", preset: "youtube-16x9" },
    { slug: "kept", preset: "vertical-9x16" },
  ]);

  for (const worker of [...workers]) {
    worker.emit("message", {
      type: "done",
      outputPath: "/unused",
      outputLabel: "out/kept/x.mp4",
    });
    await settle(worker);
  }

  // Pile plenty of unrelated settled history on top.
  for (let i = 0; i < 230; i += 1) {
    await runOne(manager, workers, i);
  }

  const retained = manager.getBatch(batch.id);
  assert.equal(
    retained.jobs.length,
    2,
    "a batch's member jobs survive trimming while the batch does",
  );
  assert.equal(retained.totalJobs, 2);
});

test("settled batches are trimmed too, oldest first", async (t) => {
  const { manager, workers } = await managerWithWorkers(t);

  const ids: string[] = [];

  for (let i = 0; i < 60; i += 1) {
    const { batch } = manager.startBatch([
      { slug: `batch-${i}`, preset: "youtube-16x9" },
    ]);
    ids.push(batch.id);

    const worker = workers[workers.length - 1];
    worker.emit("message", {
      type: "done",
      outputPath: "/unused",
      outputLabel: `out/batch-${i}/youtube-16x9.mp4`,
    });
    await settle(worker);
  }

  const batches = manager.listBatches();
  assert.ok(
    batches.length <= 50,
    `kept ${batches.length} batches, expected at most 50`,
  );

  // The newest is still addressable; the oldest has gone.
  assert.doesNotThrow(() => manager.getBatch(ids[ids.length - 1]));
  assert.throws(() => manager.getBatch(ids[0]), {
    code: "RENDER_BATCH_NOT_FOUND",
  });
});
