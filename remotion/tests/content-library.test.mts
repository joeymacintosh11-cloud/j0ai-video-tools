import assert from "node:assert/strict";
import test from "node:test";
import type { DeliveryLogEvent } from "../src/domain/delivery/deliveryHistory.ts";
import {
  buildLibraryEntries,
  CONTENT_LIBRARY_DEFAULT_LIMIT,
  CONTENT_LIBRARY_MAX_LIMIT,
  CONTENT_LIBRARY_SCHEMA_VERSION,
  CONTENT_LIBRARY_STATUS_NOTES,
  libraryTargetKey,
  parseContentLibrary,
  parseContentLibraryLine,
  parseContentLibraryQuery,
  selectContentLibrary,
  summarizeContentLibrary,
  summarizeTrackFormats,
  type ContentLibraryRecord,
  type LiveExportFacts,
} from "../src/domain/library/contentLibrary.ts";
import { TrackError } from "../src/domain/tracks/errors.ts";

/**
 * The content library's pure domain: record shape, parsing, derived status,
 * querying and summaries (src/domain/library/contentLibrary.ts). No
 * filesystem — every input is hand-built, so each rule is pinned on its own.
 */

const hex = (seed: string, length = 64) => seed.repeat(length).slice(0, length);
const INPUTS = {
  metadata: hex("a"),
  cover: hex("b"),
  audio: hex("c"),
  preset: hex("d"),
  visualizer: hex("e"),
};

let counter = 0;
const record = (overrides: Partial<ContentLibraryRecord> = {}): ContentLibraryRecord => {
  counter += 1;
  const id = counter.toString(16).padStart(32, "0");
  return {
    schemaVersion: CONTENT_LIBRARY_SCHEMA_VERSION,
    recordId: id,
    kind: "export",
    source: "render",
    generatedAt: new Date(Date.UTC(2026, 8, 1, 12, 0, counter)).toISOString(),
    recordedAt: new Date(Date.UTC(2026, 8, 1, 12, 0, counter)).toISOString(),
    track: { slug: "probe", title: "Probe", artist: "Toshi", key: "F Minor", bpm: 100 },
    preset: { id: "youtube-16x9", label: "YouTube 16:9", width: 1920, height: 1080, fps: 30 },
    template: { composition: "ToshiBeatVisualizer", visualizerVersion: "toshi-1" },
    output: { path: "out/probe/youtube-16x9.mp4", bytes: 1000 + counter, mtimeMs: counter, ino: counter },
    manifest: { path: "out/probe/youtube-16x9.manifest.json", inputFingerprint: hex("f"), inputs: INPUTS },
    renderJobId: null,
    exportKind: "original",
    replaces: null,
    ...overrides,
  };
};

const onDisk = (r: ContentLibraryRecord, freshness: LiveExportFacts["freshness"] = "current"): LiveExportFacts => ({
  freshness,
  manifest: { generatedAt: r.generatedAt, inputFingerprint: r.manifest.inputFingerprint, output: r.output },
});

const live = (entries: readonly [ContentLibraryRecord | [string, string], LiveExportFacts][]) =>
  new Map(
    entries.map(([target, facts]) => [
      Array.isArray(target) ? libraryTargetKey(target[0], target[1]) : libraryTargetKey(target.track.slug, target.preset.id),
      facts,
    ]),
  );

const lines = (...values: unknown[]) => values.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n") + "\n";

/* ------------------------------------------------------------------ *
 * Serialization, parsing, schema
 * ------------------------------------------------------------------ */

test("a record survives a JSON round trip and parses back identically", () => {
  const original = record({ renderJobId: "job-1" });
  const parsed = parseContentLibraryLine(JSON.stringify(original));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.ok && parsed.record, original);
});

test("a re-export record carries what it replaced and why", () => {
  const replaced = record();
  const reexport = record({
    exportKind: "reexport",
    replaces: {
      recordId: replaced.recordId,
      generatedAt: replaced.generatedAt,
      inputFingerprint: replaced.manifest.inputFingerprint,
      changed: ["cover_changed"],
    },
  });
  assert.equal(parseContentLibraryLine(JSON.stringify(reexport)).ok, true);
});

test("a record from a newer schema is unsupported, not corrupt", () => {
  const future = { ...record(), schemaVersion: CONTENT_LIBRARY_SCHEMA_VERSION + 1 };
  const read = parseContentLibrary(lines(record(), future));
  assert.equal(read.status, "unsupported");
  assert.equal(read.records.length, 1);
  assert.equal(read.problems[0].kind, "unsupported");
  assert.ok(CONTENT_LIBRARY_STATUS_NOTES.unsupported);
});

test("records whose kind and lineage contradict each other are rejected", () => {
  for (const bad of [
    record({ exportKind: "original", replaces: { recordId: null, generatedAt: null, inputFingerprint: null, changed: [] } }),
    record({ exportKind: "reexport", replaces: null }),
    record({ source: "adopted", exportKind: "original" }),
    record({ recordId: "not-a-hex-id" }),
    record({ replaces: { recordId: null, generatedAt: null, inputFingerprint: null, changed: ["made_up" as never] }, exportKind: "reexport" }),
  ]) {
    assert.equal(parseContentLibraryLine(JSON.stringify(bad)).ok, false, JSON.stringify(bad).slice(0, 80));
  }
});

/* ------------------------------------------------------------------ *
 * Malformed and truncated lines never take valid history with them
 * ------------------------------------------------------------------ */

test("a malformed line in the middle is corruption, and every valid record around it is still read", () => {
  const first = record();
  const last = record();
  const read = parseContentLibrary(lines(first, "{not json", { hello: "world" }, last));
  assert.equal(read.status, "corrupt");
  assert.deepEqual(read.records.map((r) => r.recordId), [first.recordId, last.recordId]);
  assert.deepEqual(read.problems.map((p) => [p.line, p.kind]), [[2, "malformed"], [3, "malformed"]]);
});

test("an unterminated, unparseable final line is a recoverable truncation, not corruption", () => {
  const kept = record();
  const text = `${JSON.stringify(kept)}\n${JSON.stringify(record()).slice(0, 40)}`;
  const read = parseContentLibrary(text);
  assert.equal(read.status, "recovered_tail");
  assert.equal(read.endsWithNewline, false);
  assert.deepEqual(read.records.map((r) => r.recordId), [kept.recordId]);
  assert.equal(read.problems[0].kind, "truncated");
});

test("an unterminated but complete final line still parses, and says it is unterminated", () => {
  const only = record();
  const read = parseContentLibrary(JSON.stringify(only));
  assert.equal(read.status, "complete");
  assert.equal(read.records.length, 1);
  assert.equal(read.endsWithNewline, false);
});

test("a repeated record is reported once as a duplicate and never counted twice", () => {
  const once = record();
  const read = parseContentLibrary(lines(once, once, record()));
  assert.equal(read.status, "duplicated");
  assert.equal(read.records.length, 2);
  assert.equal(read.problems.filter((p) => p.kind === "duplicate").length, 1);
});

test("blank lines and an empty file are harmless", () => {
  assert.equal(parseContentLibrary("").status, "complete");
  assert.equal(parseContentLibrary("\n\n").records.length, 0);
  assert.equal(parseContentLibrary(lines(record(), "", record())).records.length, 2);
});

/* ------------------------------------------------------------------ *
 * Derived status — never stored
 * ------------------------------------------------------------------ */

test("the version on disk is current or stale by freshness; earlier versions are superseded", () => {
  const first = record();
  const second = record({ exportKind: "reexport", replaces: { recordId: first.recordId, generatedAt: first.generatedAt, inputFingerprint: first.manifest.inputFingerprint, changed: [] } });

  const fresh = buildLibraryEntries([first, second], live([[second, onDisk(second, "current")]]), null);
  assert.deepEqual(fresh.map((e) => e.status), ["superseded", "current"]);
  assert.equal(fresh[0].supersededBy, second.recordId);
  assert.equal(fresh[1].supersededBy, null);

  const stale = buildLibraryEntries([first, second], live([[second, onDisk(second, "stale")]]), null);
  assert.equal(stale[1].status, "stale");
  const invalid = buildLibraryEntries([first, second], live([[second, onDisk(second, "invalid")]]), null);
  assert.equal(invalid[1].status, "stale", "on disk but not confirmable reads as stale, never current");
});

test("a version whose file is gone, with nothing after it, is missing", () => {
  const only = record();
  const gone = buildLibraryEntries([only], live([[only, { freshness: "missing", manifest: null }]]), null);
  assert.equal(gone[0].status, "missing");
  const unknownTrack = buildLibraryEntries([only], new Map(), null);
  assert.equal(unknownTrack[0].status, "missing");
});

test("a version replaced by an unrecorded export reads as superseded, not current", () => {
  const only = record();
  const other = record();
  const replacedOffBook = buildLibraryEntries([only], live([[only, onDisk(other, "current")]]), null);
  assert.equal(replacedOffBook[0].status, "superseded");
  assert.equal(replacedOffBook[0].supersededBy, null);
});

test("derived status never mutates the records it was derived from", () => {
  const only = record();
  const frozen = JSON.stringify(only);
  buildLibraryEntries([only], live([[only, onDisk(only, "stale")]]), []);
  assert.equal(JSON.stringify(only), frozen);
});

/* ------------------------------------------------------------------ *
 * Delivery attribution
 * ------------------------------------------------------------------ */

const delivery = (at: string, fingerprint: string, overrides: Partial<DeliveryLogEvent> = {}): DeliveryLogEvent => ({
  schemaVersion: 1,
  eventId: `e-${at}`,
  kind: "delivery",
  source: "delivery",
  deliveredAt: at,
  track: { slug: "probe", title: "Probe", artist: "Toshi", key: "F Minor", bpm: 100 },
  preset: { id: "youtube-16x9", label: "YouTube 16:9", width: 1920, height: 1080, fps: 30 },
  path: "probe/probe-youtube-16x9.mp4",
  bytes: 1,
  exportFingerprint: fingerprint,
  deliveryId: `d-${at}`,
  ...overrides,
});

test("deliveries are attributed to the version that was current when each happened", () => {
  const first = record({ generatedAt: "2026-09-01T10:00:00.000Z" });
  const second = record({
    generatedAt: "2026-09-05T10:00:00.000Z",
    manifest: { ...first.manifest, inputFingerprint: hex("9") },
    exportKind: "reexport",
    replaces: { recordId: first.recordId, generatedAt: first.generatedAt, inputFingerprint: first.manifest.inputFingerprint, changed: ["cover_changed"] },
  });
  const events = [
    delivery("2026-09-02T00:00:00.000Z", first.manifest.inputFingerprint),
    delivery("2026-09-03T00:00:00.000Z", first.manifest.inputFingerprint),
    delivery("2026-09-06T00:00:00.000Z", second.manifest.inputFingerprint),
    // Wrong fingerprint for its window: never counted against either version.
    delivery("2026-09-07T00:00:00.000Z", hex("0")),
    // Another format entirely.
    delivery("2026-09-06T00:00:00.000Z", second.manifest.inputFingerprint, { preset: { id: "square-1x1", label: "Square 1:1", width: 1080, height: 1080, fps: 30 } }),
  ];
  const entries = buildLibraryEntries([first, second], new Map(), events);
  assert.deepEqual(entries[0].deliveries, { count: 2, lastDeliveredAt: "2026-09-03T00:00:00.000Z" });
  assert.deepEqual(entries[1].deliveries, { count: 1, lastDeliveredAt: "2026-09-06T00:00:00.000Z" });
});

test("with no destination, delivery facts are null rather than a misleading zero", () => {
  const entries = buildLibraryEntries([record()], new Map(), null);
  assert.equal(entries[0].deliveries, null);
  const withEmptyLog = buildLibraryEntries([record()], new Map(), []);
  assert.deepEqual(withEmptyLog[0].deliveries, { count: 0, lastDeliveredAt: null });
});

/* ------------------------------------------------------------------ *
 * Filters, dates, ordering, lookup
 * ------------------------------------------------------------------ */

const library = () => {
  const a1 = record({ generatedAt: "2026-09-01T00:00:00.000Z", renderJobId: "job-a" });
  const a2 = record({
    generatedAt: "2026-09-10T00:00:00.000Z",
    renderJobId: "job-b",
    exportKind: "reexport",
    replaces: { recordId: a1.recordId, generatedAt: a1.generatedAt, inputFingerprint: a1.manifest.inputFingerprint, changed: [] },
  });
  const square = record({
    generatedAt: "2026-09-05T00:00:00.000Z",
    preset: { id: "square-1x1", label: "Square 1:1", width: 1080, height: 1080, fps: 30 },
  });
  const other = record({
    generatedAt: "2026-09-07T00:00:00.000Z",
    track: { slug: "other", title: "Other", artist: "Toshi", key: "C Minor", bpm: 90 },
  });
  const records = [a1, a2, square, other];
  const entries = buildLibraryEntries(records, live([[a2, onDisk(a2)], [square, onDisk(square, "stale")], [other, onDisk(other)]]), null);
  return { a1, a2, square, other, entries };
};

test("filters by track, format, status, kind, job and id", () => {
  const { a1, a2, square, other, entries } = library();
  const ids = (filter: Parameters<typeof selectContentLibrary>[1]) =>
    selectContentLibrary(entries, filter).entries.map((e) => e.record.recordId).sort();

  assert.deepEqual(ids({ track: "other" }), [other.recordId]);
  assert.deepEqual(ids({ preset: "square-1x1" }), [square.recordId]);
  assert.deepEqual(ids({ status: "superseded" }), [a1.recordId]);
  assert.deepEqual(ids({ status: "stale" }), [square.recordId]);
  assert.deepEqual(ids({ exportKind: "reexport" }), [a2.recordId]);
  assert.deepEqual(ids({ exportKind: "original" }), [a1.recordId, square.recordId, other.recordId].sort());
  assert.deepEqual(ids({ renderJobId: "job-a" }), [a1.recordId]);
  assert.deepEqual(ids({ recordId: a2.recordId }), [a2.recordId]);
  assert.deepEqual(ids({ track: "probe", preset: "youtube-16x9", status: "current" }), [a2.recordId]);
});

test("date bounds are inclusive below and exclusive above, so adjacent ranges never double-count", () => {
  const { a1, square, other, entries } = library();
  const ids = (from: string | null, to: string | null) =>
    selectContentLibrary(entries, { from, to, order: "oldest" }).entries.map((e) => e.record.recordId);
  assert.deepEqual(ids("2026-09-01T00:00:00.000Z", "2026-09-07T00:00:00.000Z"), [a1.recordId, square.recordId]);
  assert.deepEqual(ids("2026-09-07T00:00:00.000Z", "2026-09-10T00:00:00.000Z"), [other.recordId]);
});

test("newest first by default, oldest first on request, append order breaking ties", () => {
  const { a1, a2, square, other, entries } = library();
  assert.deepEqual(
    selectContentLibrary(entries).entries.map((e) => e.record.recordId),
    [a2.recordId, other.recordId, square.recordId, a1.recordId],
  );
  assert.deepEqual(
    selectContentLibrary(entries, { order: "oldest" }).entries.map((e) => e.record.recordId),
    [a1.recordId, square.recordId, other.recordId, a2.recordId],
  );

  const sameInstant = "2026-09-20T00:00:00.000Z";
  const x = record({ generatedAt: sameInstant, track: { slug: "t1", title: "T1", artist: "", key: "", bpm: 1 } });
  const y = record({ generatedAt: sameInstant, track: { slug: "t2", title: "T2", artist: "", key: "", bpm: 1 } });
  const tied = buildLibraryEntries([x, y], new Map(), null);
  assert.deepEqual(selectContentLibrary(tied, { order: "oldest" }).entries.map((e) => e.record.recordId), [x.recordId, y.recordId]);
});

test("a limit is always bounded, and matched reports the total before it", () => {
  const records = Array.from({ length: CONTENT_LIBRARY_MAX_LIMIT + 5 }, () => record());
  const entries = buildLibraryEntries(records, new Map(), null);
  assert.equal(selectContentLibrary(entries).entries.length, CONTENT_LIBRARY_DEFAULT_LIMIT);
  assert.equal(selectContentLibrary(entries, { limit: 10_000 }).entries.length, CONTENT_LIBRARY_MAX_LIMIT);
  assert.equal(selectContentLibrary(entries, { limit: Number.NaN }).entries.length, CONTENT_LIBRARY_DEFAULT_LIMIT);
  assert.equal(selectContentLibrary(entries, { limit: 3 }).matched, records.length);
});

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

test("a track's format summary lists every known format, generated or not, plus retired ones from history", () => {
  const { entries } = library();
  const retired = buildLibraryEntries(
    [record({ preset: { id: "legacy-4x3", label: "Legacy 4:3", width: 1440, height: 1080, fps: 30 } })],
    new Map(),
    null,
  );
  const formats = summarizeTrackFormats([...entries, ...retired], "probe", [
    { id: "youtube-16x9", label: "YouTube 16:9" },
    { id: "vertical-9x16", label: "Reels 9:16" },
    { id: "square-1x1", label: "Square 1:1" },
  ]);
  assert.deepEqual(
    formats.map((f) => [f.presetId, f.versions, f.latestStatus]),
    [
      ["youtube-16x9", 2, "current"],
      ["vertical-9x16", 0, null],
      ["square-1x1", 1, "stale"],
      ["legacy-4x3", 1, "missing"],
    ],
  );
});

test("the library summary counts every status and distinct track", () => {
  const { entries } = library();
  const summary = summarizeContentLibrary(entries);
  assert.equal(summary.total, 4);
  assert.equal(summary.tracks, 2);
  assert.deepEqual(summary.byStatus, { current: 2, stale: 1, superseded: 1, missing: 0 });
  assert.equal(summary.lastGeneratedAt, "2026-09-10T00:00:00.000Z");
});

/* ------------------------------------------------------------------ *
 * Query parsing, shared by the API and the CLI
 * ------------------------------------------------------------------ */

test("query parsing accepts every valid filter and normalizes relative periods", () => {
  const now = new Date("2026-09-29T12:00:00.000Z");
  const filter = parseContentLibraryQuery(
    { track: "ghetto-geek", preset: "youtube-16x9", status: "stale", kind: "reexport", job: "0f8f-abc", id: hex("a", 32), since: "7d", order: "oldest", limit: "25" },
    now,
  );
  assert.equal(filter.from, "2026-09-22T12:00:00.000Z");
  assert.equal(filter.limit, 25);
  assert.equal(filter.order, "oldest");
  assert.equal(filter.exportKind, "reexport");
  const defaults = parseContentLibraryQuery({});
  assert.equal(defaults.limit, CONTENT_LIBRARY_DEFAULT_LIMIT);
  assert.equal(defaults.order, "newest");
});

test("query parsing refuses anything malformed with an actionable message", () => {
  for (const raw of [
    { track: "../etc" },
    { preset: "YouTube 16:9" },
    { status: "done" },
    { kind: "remix" },
    { job: "has spaces" },
    { id: "abc" },
    { from: "last tuesday" },
    { from: "7d", since: "7d" },
    { order: "random" },
    { limit: "0" },
    { limit: String(CONTENT_LIBRARY_MAX_LIMIT + 1) },
  ]) {
    assert.throws(() => parseContentLibraryQuery(raw), TrackError, JSON.stringify(raw));
  }
});
