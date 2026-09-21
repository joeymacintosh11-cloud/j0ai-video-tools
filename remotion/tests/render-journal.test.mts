import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  classifyRecoveredJob,
  isSeriousJournalDamage,
  parseRenderJournal,
  parseRenderJournalLine,
  reconstructRenderJournal,
  RENDER_JOURNAL_SCHEMA_VERSION,
  selectRetainedEvents,
  type RenderJournalEvent,
  type RenderJournalLifecycleState,
} from "../src/domain/render/renderJournal.ts";

const BOOT_A = "boot-a";
const BOOT_B = "boot-b";

const event = (overrides: Partial<RenderJournalEvent> = {}): RenderJournalEvent => ({
  schemaVersion: RENDER_JOURNAL_SCHEMA_VERSION,
  eventId: randomUUID(),
  jobId: "job-1",
  batchId: null,
  slug: "probe",
  presetId: "youtube-16x9",
  state: "queued",
  recordedAt: "2026-09-21T12:00:00.000Z",
  bootId: BOOT_A,
  error: null,
  ...overrides,
});

const line = (e: RenderJournalEvent): string => `${JSON.stringify(e)}\n`;

const lifecycle = (
  jobId: string,
  states: readonly RenderJournalLifecycleState[],
  bootId = BOOT_A,
): RenderJournalEvent[] =>
  states.map((state, index) =>
    event({
      jobId,
      state,
      bootId,
      recordedAt: new Date(Date.UTC(2026, 8, 21, 12, 0, index)).toISOString(),
    }),
  );

/* ------------------------------------------------------------------ *
 * Line parsing
 * ------------------------------------------------------------------ */

test("parseRenderJournalLine accepts a well-formed event and rejects garbage", () => {
  const ok = parseRenderJournalLine(JSON.stringify(event()));
  assert.equal(ok.ok, true);

  assert.equal(parseRenderJournalLine("not json").ok, false);
  assert.equal(parseRenderJournalLine("[]").ok, false);
  assert.equal(parseRenderJournalLine(JSON.stringify({ ...event(), state: "bogus" })).ok, false);
  assert.equal(parseRenderJournalLine(JSON.stringify({ ...event(), eventId: "" })).ok, false);
  assert.equal(parseRenderJournalLine(JSON.stringify({ ...event(), schemaVersion: 0 })).ok, false);
});

test("parseRenderJournalLine reports a newer schema as unsupported, not malformed", () => {
  const result = parseRenderJournalLine(JSON.stringify(event({ schemaVersion: 99 })));
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "unsupported");
});

test("parseRenderJournalLine bounds an oversized line rather than parsing it", () => {
  const huge = JSON.stringify(event({ jobId: "x".repeat(20_000) }));
  const result = parseRenderJournalLine(huge);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.kind, "oversized");
});

/* ------------------------------------------------------------------ *
 * Whole-file parsing
 * ------------------------------------------------------------------ */

test("parseRenderJournal reads a clean file as complete", () => {
  const text = lifecycle("job-1", ["queued", "preparing", "rendering", "completed"]).map(line).join("");
  const read = parseRenderJournal(text);
  assert.equal(read.status, "complete");
  assert.equal(read.events.length, 4);
  assert.equal(read.problems.length, 0);
});

test("an unterminated final line is recovered_tail, not corrupt", () => {
  const events = lifecycle("job-1", ["queued", "preparing"]);
  // A genuine crash mid-append cuts the JSON itself, not just the trailing
  // newline — a complete object with no newline still parses fine (this is
  // exactly what an fsync'd-but-not-yet-newline-terminated append is not;
  // appendLine always writes the newline as part of the same write).
  const secondLine = JSON.stringify(events[1]);
  const text = `${line(events[0])}${secondLine.slice(0, secondLine.length - 10)}`;
  const read = parseRenderJournal(text);
  assert.equal(read.status, "recovered_tail");
  assert.equal(read.events.length, 1);
  assert.equal(read.problems[0].kind, "truncated");
  assert.equal(isSeriousJournalDamage(read.status), false);
});

test("damage anywhere but the final line is corrupt, and is treated as serious", () => {
  const events = lifecycle("job-1", ["queued", "preparing", "rendering"]);
  const text = `${line(events[0])}not json at all\n${line(events[2])}`;
  const read = parseRenderJournal(text);
  assert.equal(read.status, "corrupt");
  assert.equal(read.events.length, 2);
  assert.equal(isSeriousJournalDamage(read.status), true);
});

test("a repeated eventId is reported as duplicated, not silently doubled", () => {
  const first = event({ state: "queued" });
  const text = `${line(first)}${line(first)}`;
  const read = parseRenderJournal(text);
  assert.equal(read.status, "duplicated");
  assert.equal(read.events.length, 2);
  assert.equal(read.problems.some((p) => p.kind === "duplicate"), true);
});

test("a future schema version is unsupported but earlier events on the same file still read", () => {
  const events = lifecycle("job-1", ["queued", "preparing"]);
  const text = `${line(events[0])}${line({ ...events[1], schemaVersion: 2 })}`;
  const read = parseRenderJournal(text);
  assert.equal(read.status, "unsupported");
  assert.equal(read.events.length, 1);
});

test("a missing file reads as an empty, non-serious file elsewhere in the stack", () => {
  const read = parseRenderJournal("");
  assert.equal(read.status, "complete");
  assert.deepEqual(read.events, []);
  assert.equal(read.endsWithNewline, true);
});

/* ------------------------------------------------------------------ *
 * Reconstruction / legal transitions
 * ------------------------------------------------------------------ */

test("reconstruction folds a normal lifecycle down to its latest state", () => {
  const events = lifecycle("job-1", ["queued", "preparing", "rendering", "completed"]);
  const { jobs, quarantined } = reconstructRenderJournal(events);
  assert.equal(jobs.get("job-1")?.state, "completed");
  assert.equal(quarantined.length, 0);
});

test("queued -> cancelled and preparing -> cancelled are both legal (cancel before/after start)", () => {
  assert.equal(reconstructRenderJournal(lifecycle("a", ["queued", "cancelled"])).jobs.get("a")?.state, "cancelled");
  assert.equal(
    reconstructRenderJournal(lifecycle("b", ["queued", "preparing", "cancelled"])).jobs.get("b")?.state,
    "cancelled",
  );
});

test("a job may fail from any active state", () => {
  for (const states of [
    ["queued", "failed"],
    ["queued", "preparing", "failed"],
    ["queued", "preparing", "rendering", "failed"],
  ] as const) {
    const { jobs } = reconstructRenderJournal(lifecycle(randomUUID(), states));
    assert.equal([...jobs.values()][0].state, "failed");
  }
});

test("terminal immutability: an event after a terminal state is quarantined, not applied", () => {
  const events = lifecycle("job-1", ["queued", "preparing", "completed"]);
  const bogus = event({ jobId: "job-1", state: "rendering", recordedAt: "2026-09-21T12:00:10.000Z" });
  const { jobs, quarantined } = reconstructRenderJournal([...events, bogus]);
  assert.equal(jobs.get("job-1")?.state, "completed");
  assert.equal(quarantined.length, 1);
  assert.match(quarantined[0].reason, /cannot move from "completed" to "rendering"/);
});

test("conflicting terminal states: the first legal one wins, the second is quarantined and surfaced", () => {
  const completed = event({ jobId: "job-1", state: "completed", recordedAt: "2026-09-21T12:00:00.000Z" });
  const failed = event({ jobId: "job-1", state: "failed", recordedAt: "2026-09-21T12:00:01.000Z" });
  const { jobs, quarantined } = reconstructRenderJournal([completed, failed]);
  assert.equal(jobs.get("job-1")?.state, "completed");
  assert.equal(quarantined.length, 1);
});

test("a duplicate identical event is idempotent and produces no quarantine", () => {
  const first = event({ jobId: "job-1", state: "completed" });
  const { jobs, quarantined } = reconstructRenderJournal([first, first]);
  assert.equal(jobs.get("job-1")?.state, "completed");
  assert.equal(quarantined.length, 0);
});

test("a same-state repeat (not a duplicate eventId) is a harmless idempotent no-op", () => {
  const a = event({ jobId: "job-1", state: "rendering", recordedAt: "2026-09-21T12:00:00.000Z" });
  const b = event({ jobId: "job-1", state: "rendering", recordedAt: "2026-09-21T12:00:05.000Z" });
  const { jobs, quarantined } = reconstructRenderJournal([a, b]);
  assert.equal(jobs.get("job-1")?.state, "rendering");
  assert.equal(quarantined.length, 0);
});

test("a job's first observed event is accepted whatever it is, when earlier history is gone", () => {
  // Simulates a tail-repaired or corrupted region having eaten the queued/preparing events.
  const { jobs, quarantined } = reconstructRenderJournal([event({ jobId: "job-1", state: "rendering" })]);
  assert.equal(jobs.get("job-1")?.state, "rendering");
  assert.equal(quarantined.length, 0);
});

test("independent jobs never interfere with each other's reconstruction", () => {
  const a = lifecycle("job-a", ["queued", "preparing", "completed"]);
  const b = lifecycle("job-b", ["queued", "failed"]);
  const { jobs } = reconstructRenderJournal([...a, ...b]);
  assert.equal(jobs.get("job-a")?.state, "completed");
  assert.equal(jobs.get("job-b")?.state, "failed");
});

/* ------------------------------------------------------------------ *
 * Recovery classification
 * ------------------------------------------------------------------ */

test("a non-terminal job from a different boot is classified interrupted, never as still active", () => {
  const { jobs } = reconstructRenderJournal(lifecycle("job-1", ["queued", "preparing", "rendering"], BOOT_A));
  const recovered = classifyRecoveredJob(jobs.get("job-1")!, BOOT_B);
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.recoveredAfterRestart, true);
});

test("a terminal job keeps its real terminal status after recovery, whichever boot answers", () => {
  for (const state of ["completed", "failed", "cancelled"] as const) {
    const { jobs } = reconstructRenderJournal(lifecycle("job-1", ["queued", "preparing", state], BOOT_A));
    const sameProcess = classifyRecoveredJob(jobs.get("job-1")!, BOOT_A);
    const afterRestart = classifyRecoveredJob(jobs.get("job-1")!, BOOT_B);
    assert.equal(sameProcess.status, state);
    assert.equal(sameProcess.recoveredAfterRestart, false);
    assert.equal(afterRestart.status, state);
    assert.equal(afterRestart.recoveredAfterRestart, true);
  }
});

test("recovery never fabricates completion, cancellation or any live-looking state", () => {
  const { jobs } = reconstructRenderJournal(lifecycle("job-1", ["queued", "preparing"], BOOT_A));
  const recovered = classifyRecoveredJob(jobs.get("job-1")!, BOOT_B);
  assert.notEqual(recovered.status, "completed");
  assert.notEqual(recovered.status, "cancelled");
  assert.notEqual(recovered.status, "queued");
  assert.notEqual(recovered.status, "preparing");
  assert.notEqual(recovered.status, "rendering");
});

/* ------------------------------------------------------------------ *
 * Retention / compaction selection
 * ------------------------------------------------------------------ */

test("retention keeps full history for a still-open job however old", () => {
  const old = lifecycle("job-1", ["queued", "preparing", "rendering"], BOOT_A).map((e) => ({
    ...e,
    recordedAt: "2020-01-01T00:00:00.000Z",
  }));
  const retained = selectRetainedEvents(old, new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(retained.length, 3);
});

test("retention drops a terminal job outside the window entirely", () => {
  const old = lifecycle("job-1", ["queued", "preparing", "completed"], BOOT_A).map((e) => ({
    ...e,
    recordedAt: "2020-01-01T00:00:00.000Z",
  }));
  const retained = selectRetainedEvents(old, new Date("2026-09-21T00:00:00.000Z"));
  assert.equal(retained.length, 0);
});

test("retention keeps only the accepted terminal event for a settled job within the window, not its whole history", () => {
  const events = lifecycle("job-1", ["queued", "preparing", "rendering", "completed"], BOOT_A);
  const retained = selectRetainedEvents(events, new Date("2026-09-21T13:00:00.000Z"));
  assert.equal(retained.length, 1);
  assert.equal(retained[0].state, "completed");
});

test("retention caps terminal jobs by count, keeping the most recent", () => {
  const events = Array.from({ length: 5 }, (_, i) =>
    lifecycle(`job-${i}`, ["queued", "preparing", "completed"], BOOT_A).map((e) => ({
      ...e,
      recordedAt: new Date(Date.UTC(2026, 8, 21, i)).toISOString(),
    })),
  ).flat();
  const retained = selectRetainedEvents(events, new Date("2026-09-21T23:00:00.000Z"), 30, 2);
  const retainedJobs = new Set(retained.map((e) => e.jobId));
  assert.equal(retainedJobs.size, 2);
  assert.ok(retainedJobs.has("job-3"));
  assert.ok(retainedJobs.has("job-4"));
});

test("retention never keeps a rejected/quarantined terminal event over the accepted one", () => {
  // job-1 legitimately completes, then an illegal second terminal event
  // ("failed") is appended later in the file — corruption or a bug elsewhere.
  const queued = event({ jobId: "job-1", state: "queued", recordedAt: "2026-09-21T11:58:00.000Z" });
  const preparing = event({ jobId: "job-1", state: "preparing", recordedAt: "2026-09-21T11:59:00.000Z" });
  const completed = event({ jobId: "job-1", state: "completed", recordedAt: "2026-09-21T12:00:00.000Z" });
  const bogusFailed = event({ jobId: "job-1", state: "failed", recordedAt: "2026-09-21T12:05:00.000Z" });
  const retained = selectRetainedEvents(
    [queued, preparing, completed, bogusFailed],
    new Date("2026-09-21T13:00:00.000Z"),
  );
  assert.equal(retained.length, 1);
  assert.equal(retained[0].eventId, completed.eventId);
});
