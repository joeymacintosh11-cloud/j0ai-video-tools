import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  classifyRecoveredJob,
  formatRecentRenderTimestamp,
  isSeriousJournalDamage,
  parseRenderJournal,
  parseRenderJournalLine,
  recentRenderJobsForSlug,
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

/* ------------------------------------------------------------------ *
 * Operator-facing recent history (one track, grouped by job)
 * ------------------------------------------------------------------ */

test("recentRenderJobsForSlug groups a job's whole lifecycle into one entry, not one per event", () => {
  const events = lifecycle("job-1", ["queued", "preparing", "rendering", "completed"]);
  const { jobs, order } = reconstructRenderJournal(events);
  const recent = recentRenderJobsForSlug({ jobs, order, quarantined: [] }, "probe", BOOT_A, 10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].status, "completed");
});

test("recentRenderJobsForSlug excludes every other track's jobs", () => {
  const mine = lifecycle("job-1", ["queued", "preparing", "completed"]);
  const theirs = lifecycle("job-2", ["queued", "preparing", "completed"]).map((e) => ({ ...e, slug: "other-track" }));
  const reconstruction = reconstructRenderJournal([...mine, ...theirs]);
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_A, 10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].jobId, "job-1");
});

test("recentRenderJobsForSlug orders by file position, not by recordedAt — file order is the true order across boots with skewed clocks", () => {
  // job-2 is genuinely later in the file (a second process, boot B, appended
  // after job-1 settled) but carries an *earlier* wall-clock timestamp than
  // job-1's own final event — exactly the clock-skew scenario file order
  // exists to be immune to.
  const jobOne = lifecycle("job-1", ["queued", "preparing", "completed"], BOOT_A).map((e) => ({
    ...e,
    recordedAt: "2026-09-21T12:00:00.000Z",
  }));
  const jobTwo = lifecycle("job-2", ["queued", "preparing", "completed"], BOOT_B).map((e) => ({
    ...e,
    recordedAt: "2026-09-21T11:00:00.000Z", // earlier clock time, later in file
  }));
  const reconstruction = reconstructRenderJournal([...jobOne, ...jobTwo]);
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_B, 10);
  assert.deepEqual(
    recent.map((job) => job.jobId),
    ["job-2", "job-1"],
  );
});

test("recentRenderJobsForSlug exposes several presets for one track, each as its own entry", () => {
  const landscape = lifecycle("job-1", ["queued", "preparing", "completed"]).map((e) => ({
    ...e,
    presetId: "youtube-16x9",
  }));
  const vertical = lifecycle("job-2", ["queued", "failed"]).map((e) => ({
    ...e,
    presetId: "vertical-9x16",
  }));
  const reconstruction = reconstructRenderJournal([...landscape, ...vertical]);
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_A, 10);
  assert.equal(recent.length, 2);
  assert.deepEqual(
    new Set(recent.map((job) => job.presetId)),
    new Set(["youtube-16x9", "vertical-9x16"]),
  );
});

test("recentRenderJobsForSlug bounds the result to the requested limit, newest first", () => {
  const events = Array.from({ length: 5 }, (_, i) =>
    lifecycle(`job-${i}`, ["queued", "preparing", "completed"]).map((e) => ({
      ...e,
      recordedAt: new Date(Date.UTC(2026, 8, 21, i)).toISOString(),
    })),
  ).flat();
  const reconstruction = reconstructRenderJournal(events);
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_A, 2);
  assert.equal(recent.length, 2);
  assert.deepEqual(
    recent.map((job) => job.jobId),
    ["job-4", "job-3"],
  );
});

test("recentRenderJobsForSlug excludes a job currently live elsewhere, without shrinking the page below limit", () => {
  const events = Array.from({ length: 4 }, (_, i) =>
    lifecycle(`job-${i}`, ["queued", "preparing", "completed"]).map((e) => ({
      ...e,
      recordedAt: new Date(Date.UTC(2026, 8, 21, i)).toISOString(),
    })),
  ).flat();
  const reconstruction = reconstructRenderJournal(events);
  // job-3 is the newest but is currently live — it must never appear here,
  // and the two next-newest jobs fill the page instead.
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_A, 2, new Set(["job-3"]));
  assert.deepEqual(
    recent.map((job) => job.jobId),
    ["job-2", "job-1"],
  );
});

test("recentRenderJobsForSlug reports a same-boot non-terminal record as interrupted, never as live", () => {
  const events = lifecycle("job-1", ["queued", "preparing"]);
  const reconstruction = reconstructRenderJournal(events);
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_A, 10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].status, "interrupted");
});

test("recentRenderJobsForSlug reports a cross-boot non-terminal record as interrupted, with recoveredAfterRestart true", () => {
  const events = lifecycle("job-1", ["queued", "preparing", "rendering"], BOOT_A);
  const reconstruction = reconstructRenderJournal(events);
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_B, 10);
  assert.equal(recent.length, 1);
  assert.equal(recent[0].status, "interrupted");
  assert.equal(recent[0].recoveredAfterRestart, true);
});

test("recentRenderJobsForSlug survives a malformed journal tail, keeping the jobs read before it", () => {
  const events = lifecycle("job-1", ["queued", "preparing", "completed"]);
  const finalLine = JSON.stringify(events[2]);
  const text = `${line(events[0])}${line(events[1])}${finalLine.slice(0, finalLine.length - 10)}`;
  const read = parseRenderJournal(text);
  assert.equal(read.status, "recovered_tail");

  const reconstruction = reconstructRenderJournal(read.events);
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_A, 10);
  // The truncated final line was itself job-1's "completed" transition, so
  // only "queued"/"preparing" survived the crash — an honest partial answer
  // (reported "interrupted", the honest read of a non-terminal record with
  // no live owner), never a fabricated "completed".
  assert.equal(recent.length, 1);
  assert.notEqual(recent[0].status, "completed");
});

test("recentRenderJobsForSlug survives an unsupported future schema version elsewhere in the file", () => {
  const olderJob = lifecycle("job-1", ["queued", "preparing", "completed"]);
  const newerJob = lifecycle("job-2", ["queued", "preparing"]).map((e) => ({
    ...e,
    schemaVersion: e.state === "preparing" ? 99 : e.schemaVersion,
  }));
  const text = [...olderJob, ...newerJob].map(line).join("");
  const read = parseRenderJournal(text);
  assert.equal(read.status, "unsupported");

  const reconstruction = reconstructRenderJournal(read.events);
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_A, 10);
  // job-1's whole lifecycle read fine; job-2's unsupported "preparing" event
  // was dropped by the parser, leaving only its "queued" event — reported
  // as interrupted, never fabricated as completed or hidden outright.
  assert.equal(recent.length, 2);
  const byId = new Map(recent.map((job) => [job.jobId, job]));
  assert.equal(byId.get("job-1")?.status, "completed");
  assert.equal(byId.get("job-2")?.status, "interrupted");
});

test("recentRenderJobsForSlug clamps an over-large limit to the documented maximum", () => {
  const events = Array.from({ length: 15 }, (_, i) =>
    lifecycle(`job-${i}`, ["queued", "preparing", "completed"]).map((e) => ({
      ...e,
      recordedAt: new Date(Date.UTC(2026, 8, 21, i)).toISOString(),
    })),
  ).flat();
  const reconstruction = reconstructRenderJournal(events);
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_A, 10_000);
  assert.ok(recent.length <= 10);
});

/* ------------------------------------------------------------------ *
 * Timestamp formatting
 * ------------------------------------------------------------------ */

test("formatRecentRenderTimestamp reads Today/Yesterday/an older date, using the day boundary of the given `now`", () => {
  const now = new Date("2026-09-21T18:00:00.000Z");
  assert.equal(formatRecentRenderTimestamp("2026-09-21T14:32:00.000Z", now), `Today, ${new Date("2026-09-21T14:32:00.000Z").getHours().toString().padStart(2, "0")}:32`);
  assert.equal(formatRecentRenderTimestamp("2026-09-20T18:04:00.000Z", now).startsWith("Yesterday, "), true);
  assert.equal(formatRecentRenderTimestamp("2026-09-01T13:10:00.000Z", now).startsWith("1 Sep, "), true);
});

test("formatRecentRenderTimestamp falls back to the raw value for an unparseable timestamp", () => {
  assert.equal(formatRecentRenderTimestamp("not-a-date"), "not-a-date");
});

/* ------------------------------------------------------------------ *
 * Performance (§42 of the milestone this implements)
 * ------------------------------------------------------------------ */

test("recentRenderJobsForSlug stays fast at a journal near its retention bound (10,000 events)", () => {
  const events: RenderJournalEvent[] = [];
  for (let i = 0; i < 2_500; i++) {
    events.push(
      ...lifecycle(`job-${i}`, ["queued", "preparing", "rendering", "completed"]).map((e) => ({
        ...e,
        slug: i % 50 === 0 ? "probe" : `other-track-${i % 200}`,
      })),
    );
  }
  assert.equal(events.length, 10_000);

  const start = performance.now();
  const reconstruction = reconstructRenderJournal(events);
  const recent = recentRenderJobsForSlug(reconstruction, "probe", BOOT_A, 3);
  const elapsedMs = performance.now() - start;

  assert.equal(recent.length, 3);
  assert.ok(
    elapsedMs < 200,
    `parse + reconstruct + select for 10,000 events took ${elapsedMs}ms, expected well under 200ms`,
  );
});
