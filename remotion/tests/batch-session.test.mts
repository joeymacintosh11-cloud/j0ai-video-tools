import assert from "node:assert/strict";
import test from "node:test";
import {
  BATCH_SESSION_MAX_AGE_MS,
  BATCH_SESSION_MAX_JOBS,
  BATCH_SESSION_MAX_TRACKS,
  BATCH_SESSION_SCHEMA_VERSION,
  BATCH_SESSION_STORAGE_KEY,
  clearBatchSession,
  classifyRecoveredJob,
  loadBatchSession,
  mergeSessionJobReferences,
  parseBatchSession,
  pruneSessionJobIds,
  reconcileBatchSession,
  saveBatchSession,
  toSessionJobReferences,
  type BatchSession,
  type StorageLike,
} from "../ui/batchSession.ts";
import type { RenderJobView } from "../core/domain/api/views.ts";

const NOW = Date.parse("2026-09-21T12:00:00.000Z");

const reference = (slug = "track-a", jobId = "00000000-0000-4000-8000-000000000001") => ({
  actionId: `${slug}::youtube::youtube-16x9`,
  slug,
  platformId: "youtube" as const,
  presetId: "youtube-16x9" as const,
  jobId,
});

const job = (status: RenderJobView["status"], overrides: Partial<RenderJobView> = {}): RenderJobView => ({
  id: reference().jobId, slug: "track-a", presetId: "youtube-16x9", engine: "remotion", batchId: "batch",
  status, progress: 0, framesRendered: null, totalFrames: null, fps: null, elapsedMs: 0,
  startedAt: null, queuedAt: new Date(NOW).toISOString(), finishedAt: null,
  outputPath: null, outputLabel: null, error: null, ...overrides,
});

const session = (overrides: Partial<BatchSession> = {}): BatchSession => ({
  schemaVersion: BATCH_SESSION_SCHEMA_VERSION,
  savedAt: new Date(NOW).toISOString(),
  selectedSlugs: ["track-a", "track-b"],
  mode: "intent",
  platforms: [],
  jobReferences: [reference()],
  panelOpen: true,
  ...overrides,
});

const raw = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({ ...session(), ...overrides });

const memoryStorage = (initial?: string): StorageLike & { readonly values: Map<string, string> } => {
  const values = new Map<string, string>();
  if (initial !== undefined) values.set(BATCH_SESSION_STORAGE_KEY, initial);
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
};

test("persists selection, mode, explicit platforms and exact returned job references", () => {
  const storage = memoryStorage();
  const saved = saveBatchSession(storage, {
    selectedSlugs: ["track-a", "track-b"],
    mode: "platforms",
    platforms: ["youtube", "reels"],
    jobReferences: [reference()],
    panelOpen: true,
  }, NOW);
  assert.deepEqual(loadBatchSession(storage, NOW), saved);
  assert.equal(JSON.parse(storage.values.get(BATCH_SESSION_STORAGE_KEY)!).schemaVersion, 1);
});

test("malformed JSON and unsupported schema versions are ignored and removed", () => {
  for (const value of ["{", raw({ schemaVersion: 2 })]) {
    const storage = memoryStorage(value);
    assert.equal(loadBatchSession(storage, NOW), null);
    assert.equal(storage.values.has(BATCH_SESSION_STORAGE_KEY), false);
  }
});

test("duplicate tracks and platforms are deduped while malformed values are ignored", () => {
  const parsed = parseBatchSession(raw({
    selectedSlugs: ["track-a", "track-a", "../bad", 3, "track-b"],
    platforms: ["youtube", "youtube", "unknown", "reels"],
  }), NOW);
  assert.deepEqual(parsed?.selectedSlugs, ["track-a", "track-b"]);
  assert.deepEqual(parsed?.platforms, ["youtube", "reels"]);
});

test("explicit mode with no valid platforms falls back to intent", () => {
  assert.equal(parseBatchSession(raw({ mode: "platforms", platforms: ["unknown"] }), NOW)?.mode, "intent");
});

test("deleted tracks and their jobs are dropped; losing every track clears the session", () => {
  const recovered = reconcileBatchSession(session(), new Set(["track-b", "track-c"]));
  assert.deepEqual(recovered?.selectedSlugs, ["track-b"]);
  assert.deepEqual(recovered?.jobReferences, []);
  assert.equal(reconcileBatchSession(session(), new Set(["track-c"])), null);
});

test("expired and future-dated sessions are ignored", () => {
  assert.equal(parseBatchSession(raw({ savedAt: new Date(NOW - BATCH_SESSION_MAX_AGE_MS - 1).toISOString() }), NOW), null);
  assert.equal(parseBatchSession(raw({ savedAt: new Date(NOW + 60_001).toISOString() }), NOW), null);
});

test("huge/corrupt arrays and oversized raw payloads are bounded safely", () => {
  assert.equal(parseBatchSession(raw({ selectedSlugs: Array(BATCH_SESSION_MAX_TRACKS + 1).fill("track-a") }), NOW), null);
  assert.equal(parseBatchSession(raw({ jobReferences: Array(BATCH_SESSION_MAX_JOBS + 1).fill(reference()) }), NOW), null);
  assert.equal(parseBatchSession(raw({ platforms: Array(13).fill("youtube") }), NOW), null);
  assert.equal(parseBatchSession(`{"schemaVersion":1,"padding":"${"x".repeat(100_000)}"}`, NOW), null);
});

test("wrong scalar types and missing required fields are ignored", () => {
  for (const value of [
    raw({ savedAt: 42 }), raw({ selectedSlugs: "track-a" }), raw({ mode: "magic" }),
    raw({ platforms: null }), raw({ jobReferences: null }), raw({ panelOpen: "yes" }),
  ]) assert.equal(parseBatchSession(value, NOW), null);
});

test("job references require exact trusted target identity and are deduped", () => {
  const good = reference();
  const parsed = parseBatchSession(raw({ jobReferences: [
    good,
    good,
    { ...good, actionId: "wrong" },
    { ...good, presetId: "square-1x1" },
    { ...good, jobId: "../../etc/passwd" },
    { ...good, platformId: "unknown" },
  ] }), NOW);
  assert.deepEqual(parsed?.jobReferences, [good]);
});

test("returned references omit null IDs, malformed identities and duplicate actions", () => {
  const full = { ...reference(), outcome: "queued" as const };
  assert.deepEqual(toSessionJobReferences([
    full,
    { ...full, outcome: "adopted" as const },
    { ...full, actionId: "wrong" },
    { ...full, jobId: null, outcome: "locked_elsewhere" as const },
  ]), [reference()]);
});

test("new references replace the same action and terminal IDs prune without touching siblings", () => {
  const old = reference("track-a", "old-job");
  const replacement = reference("track-a", "new-job");
  const sibling = reference("track-b", "sibling-job");
  const merged = mergeSessionJobReferences([old, sibling], [replacement]);
  assert.deepEqual(merged, [replacement, sibling]);
  assert.deepEqual(pruneSessionJobIds(merged, new Set(["new-job"])), [sibling]);
});

test("queued and rendering jobs recover as active; every terminal state is prunable", () => {
  for (const status of ["queued", "preparing", "rendering"] as const) {
    assert.equal(classifyRecoveredJob(reference(), job(status)), "active");
  }
  for (const status of ["completed", "failed", "cancelled"] as const) {
    assert.equal(classifyRecoveredJob(reference(), job(status)), "terminal");
  }
});

test("recovery never adopts a job whose exact id or target identity differs", () => {
  assert.equal(classifyRecoveredJob(reference(), job("rendering", { id: "another-job" })), "mismatch");
  assert.equal(classifyRecoveredJob(reference(), job("rendering", { slug: "track-b" })), "mismatch");
  assert.equal(classifyRecoveredJob(reference(), job("rendering", { presetId: "square-1x1" })), "mismatch");
});

test("storage access failures never crash the workflow", () => {
  const broken: StorageLike = {
    getItem: () => { throw new Error("disabled"); },
    setItem: () => { throw new Error("full"); },
    removeItem: () => { throw new Error("disabled"); },
  };
  assert.equal(loadBatchSession(broken, NOW), null);
  assert.doesNotThrow(() => saveBatchSession(broken, {
    selectedSlugs: ["track-a"], mode: "intent", platforms: [], jobReferences: [], panelOpen: false,
  }, NOW));
  assert.doesNotThrow(() => clearBatchSession(broken));
});

test("clear removes persisted context immediately", () => {
  const storage = memoryStorage(raw());
  clearBatchSession(storage);
  assert.equal(storage.values.has(BATCH_SESSION_STORAGE_KEY), false);
});
