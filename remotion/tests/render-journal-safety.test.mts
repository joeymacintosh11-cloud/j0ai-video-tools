import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  reconstructRenderJournal,
} from "../core/domain/render/renderJournal.ts";
import { readRenderJournal } from "../services/render/renderJournalLog.ts";

/**
 * Cross-process durability: the render journal's regression tests.
 *
 * Kept apart from render-journal-log.test.mts the way delivery-history-safety
 * is kept apart from delivery-history — those tests describe what the file
 * does under one process; these use two real forked processes, because two
 * separate `renderManager` instances (the API server, and any CLI script
 * that renders directly) really can append to this journal at the same time.
 */

const root = async (t: TestContext): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "toshi-render-journal-safety-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

type Outcome = { readonly appended: string[]; readonly problems: string[] };

const appender = async (
  t: TestContext,
  dir: string,
  marker: string,
  jobsPerAppender: number,
) => {
  const child = fork(new URL("./render-journal-process.mts", import.meta.url), [dir, marker, String(jobsPerAppender)], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await once(child, "message"); // "ready"
  return child;
};

test("two real processes appending concurrently never interleave lines or lose an event", async (t) => {
  const dir = await root(t);
  const a = await appender(t, dir, "a", 5);
  const b = await appender(t, dir, "b", 5);

  const results = Promise.all([
    once(a, "message").then(([m]) => m as { type: string } & Outcome),
    once(b, "message").then(([m]) => m as { type: string } & Outcome),
  ]);
  a.send("go");
  b.send("go");
  const [resultA, resultB] = await results;

  assert.equal(resultA.problems.length, 0);
  assert.equal(resultB.problems.length, 0);

  const read = readRenderJournal(dir);
  assert.equal(read.status, "complete", JSON.stringify(read.problems));
  // 5 jobs * 4 lifecycle events each, from each of two appenders.
  assert.equal(read.events.length, 40);
  assert.equal(new Set(read.events.map((e) => e.eventId)).size, 40);

  const { jobs, quarantined } = reconstructRenderJournal(read.events);
  assert.equal(quarantined.length, 0);
  assert.equal(jobs.size, 10);
  for (const job of jobs.values()) {
    assert.equal(job.state, "completed");
  }
});

test("a lock left behind by a killed process is reclaimed rather than jamming the journal forever", async (t) => {
  const dir = await root(t);
  const holder = await appender(t, dir, "holder", 1);
  // Send exactly one job's worth of work, then kill mid-flight so the lock
  // file (if it managed to acquire one) is abandoned rather than released.
  holder.send("go");
  await new Promise((resolve) => setTimeout(resolve, 5));
  holder.kill("SIGKILL");

  // A fresh appender must still be able to make progress.
  const b = await appender(t, dir, "after-kill", 1);
  const done = once(b, "message").then(([m]) => m as { type: string } & Outcome);
  b.send("go");
  const result = await done;
  assert.equal(result.problems.length, 0);

  const read = readRenderJournal(dir);
  assert.equal(read.status, "complete", JSON.stringify(read.problems));
  assert.ok(read.events.some((e) => e.slug === "probe-after-kill" && e.state === "completed"));
});
