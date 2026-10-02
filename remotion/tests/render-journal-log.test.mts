import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  RENDER_JOURNAL_SCHEMA_VERSION,
  type RenderJournalEvent,
} from "../core/domain/render/renderJournal.ts";
import {
  appendRenderJournalEvent,
  compactRenderJournal,
  readRenderJournal,
  renderJournalPath,
  repairRenderJournalTail,
} from "../services/render/renderJournalLog.ts";

const root = async (t: TestContext): Promise<string> => {
  const dir = await mkdtemp(path.join(tmpdir(), "toshi-render-journal-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

const event = (overrides: Partial<RenderJournalEvent> = {}): RenderJournalEvent => ({
  schemaVersion: RENDER_JOURNAL_SCHEMA_VERSION,
  eventId: randomUUID(),
  jobId: "job-1",
  batchId: null,
  slug: "probe",
  presetId: "youtube-16x9",
  state: "queued",
  recordedAt: new Date().toISOString(),
  bootId: "boot-1",
  error: null,
  ...overrides,
});

test("readRenderJournal reports missing, not an error, for a directory that does not exist yet", async (t) => {
  const dir = await root(t);
  const read = readRenderJournal(path.join(dir, "not-created-yet"));
  assert.equal(read.status, "missing");
  assert.deepEqual(read.events, []);
});

test("append creates the directory and the file, and the event round-trips", async (t) => {
  const dir = await root(t);
  const result = await appendRenderJournalEvent(event({ state: "queued" }), dir);
  assert.equal(result.appended, true);

  const read = readRenderJournal(dir);
  assert.equal(read.status, "complete");
  assert.equal(read.events.length, 1);
  assert.equal(read.events[0].state, "queued");
});

test("sequential appends for the same job land as one event per line, in order", async (t) => {
  const dir = await root(t);
  const jobId = randomUUID();
  for (const state of ["queued", "preparing", "rendering", "completed"] as const) {
    const result = await appendRenderJournalEvent(event({ jobId, state }), dir);
    assert.equal(result.appended, true);
  }

  const read = readRenderJournal(dir);
  assert.equal(read.status, "complete");
  assert.deepEqual(read.events.map((e) => e.state), ["queued", "preparing", "rendering", "completed"]);
});

test("concurrent in-process appends never interleave or lose an event", async (t) => {
  const dir = await root(t);
  const events = Array.from({ length: 40 }, (_, i) => event({ jobId: `job-${i}`, state: "queued" }));

  await Promise.all(events.map((e) => appendRenderJournalEvent(e, dir)));

  const read = readRenderJournal(dir);
  assert.equal(read.status, "complete");
  assert.equal(read.events.length, 40);
  assert.equal(new Set(read.events.map((e) => e.eventId)).size, 40);
});

test("a symlinked journal path is refused rather than followed (O_NOFOLLOW)", async (t) => {
  const dir = await root(t);
  const outsideDir = await mkdtemp(path.join(tmpdir(), "toshi-render-journal-outside-"));
  t.after(() => rm(outsideDir, { recursive: true, force: true }));
  const outsideFile = path.join(outsideDir, "escaped.jsonl");
  await writeFile(outsideFile, "");

  const { symlink, mkdir } = await import("node:fs/promises");
  await mkdir(dir, { recursive: true });
  await symlink(outsideFile, renderJournalPath(dir));

  const result = await appendRenderJournalEvent(event(), dir);
  assert.equal(result.appended, false);
  assert.ok(result.problem);

  const escapedContent = await readFile(outsideFile, "utf8");
  assert.equal(escapedContent, "");
});

test("repairRenderJournalTail drops only a genuinely truncated final line", async (t) => {
  const dir = await root(t);
  await appendRenderJournalEvent(event({ state: "queued" }), dir);

  const file = renderJournalPath(dir);
  const good = await readFile(file, "utf8");
  const truncatedSecond = JSON.stringify(event({ state: "preparing" })).slice(0, 30);
  await writeFile(file, `${good}${truncatedSecond}`);

  const before = readRenderJournal(dir);
  assert.equal(before.status, "recovered_tail");

  const result = await repairRenderJournalTail(dir);
  assert.equal(result.repaired, true);
  assert.equal(result.discarded, truncatedSecond);

  const after = readRenderJournal(dir);
  assert.equal(after.status, "complete");
  assert.equal(after.events.length, 1);
});

test("repairRenderJournalTail refuses when there is nothing incomplete to repair", async (t) => {
  const dir = await root(t);
  await appendRenderJournalEvent(event(), dir);
  const result = await repairRenderJournalTail(dir);
  assert.equal(result.repaired, false);
  assert.match(result.problem ?? "", /nothing to repair/);
});

test("repairRenderJournalTail refuses to touch damage that is not a truncated tail", async (t) => {
  const dir = await root(t);
  await appendRenderJournalEvent(event(), dir);
  const file = renderJournalPath(dir);
  const good = await readFile(file, "utf8");
  await writeFile(file, `${good}not json at all\n`);

  const result = await repairRenderJournalTail(dir);
  assert.equal(result.repaired, false);
  assert.match(result.problem ?? "", /will not touch/);
});

test("compactRenderJournal shrinks a settled job to its one terminal event and keeps non-terminal jobs whole", async (t) => {
  const dir = await root(t);
  const settled = randomUUID();
  const open = randomUUID();

  for (const state of ["queued", "preparing", "rendering", "completed"] as const) {
    await appendRenderJournalEvent(event({ jobId: settled, state }), dir);
  }
  for (const state of ["queued", "preparing"] as const) {
    await appendRenderJournalEvent(event({ jobId: open, state }), dir);
  }

  const before = readRenderJournal(dir);
  assert.equal(before.events.length, 6);

  const result = await compactRenderJournal(dir);
  assert.equal(result.compacted, true);
  assert.equal(result.before, 6);
  assert.equal(result.after, 3);

  const after = readRenderJournal(dir);
  assert.equal(after.status, "complete");
  assert.deepEqual(
    after.events.filter((e) => e.jobId === settled).map((e) => e.state),
    ["completed"],
  );
  assert.deepEqual(
    after.events.filter((e) => e.jobId === open).map((e) => e.state),
    ["queued", "preparing"],
  );
});

test("compactRenderJournal is a no-op, not a rewrite, when nothing would shrink", async (t) => {
  const dir = await root(t);
  await appendRenderJournalEvent(event({ state: "queued" }), dir);
  await appendRenderJournalEvent(event({ jobId: randomUUID(), state: "queued" }), dir);

  const result = await compactRenderJournal(dir);
  assert.equal(result.compacted, false);
  assert.equal(result.before, 2);
  assert.equal(result.after, 2);
});

test("compactRenderJournal refuses to compact on top of unread corruption", async (t) => {
  const dir = await root(t);
  await appendRenderJournalEvent(event(), dir);
  const file = renderJournalPath(dir);
  const good = await readFile(file, "utf8");
  await writeFile(file, `not json at all\n${good}`);

  const result = await compactRenderJournal(dir);
  assert.equal(result.compacted, false);
  assert.match(result.problem ?? "", /will not be compacted/);

  // Nothing was rewritten — the damage, and the good line after it, survive untouched.
  const untouched = await readFile(file, "utf8");
  assert.equal(untouched, `not json at all\n${good}`);
});
