import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  CONTENT_LIBRARY_SCHEMA_VERSION,
  parseContentLibrary,
  type ContentLibraryRecord,
} from "../core/domain/library/contentLibrary.ts";
import {
  appendContentLibraryRecord,
  contentLibraryPath,
  readContentLibrary,
  releaseContentLibraryLock,
  repairContentLibraryTail,
} from "../services/library/contentLibraryLog.ts";

/**
 * The content library's persistence (services/library/contentLibraryLog.ts):
 * append-only, deduplicated, safe across concurrent callers and real
 * processes, and never letting one damaged line cost the rest of the history.
 * Every test uses its own temp directory — nothing here touches the real
 * out/.content-library/.
 */

const libraryRoot = async (t: TestContext) => {
  const root = await mkdtemp(path.join(tmpdir(), "toshi-library-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const hex = (seed: string) => seed.repeat(64).slice(0, 64);
let counter = 0;
const record = (overrides: Partial<ContentLibraryRecord> = {}): ContentLibraryRecord => {
  counter += 1;
  return {
    schemaVersion: CONTENT_LIBRARY_SCHEMA_VERSION,
    recordId: counter.toString(16).padStart(32, "0"),
    kind: "export",
    source: "render",
    generatedAt: new Date(Date.UTC(2026, 8, 1, 0, 0, counter)).toISOString(),
    recordedAt: new Date().toISOString(),
    track: { slug: "probe", title: "Probe", artist: "Toshi", key: "F Minor", bpm: 100 },
    preset: { id: "youtube-16x9", label: "YouTube 16:9", width: 1920, height: 1080, fps: 30 },
    template: { composition: "ToshiBeatVisualizer", visualizerVersion: "toshi-1" },
    output: { path: "out/probe/youtube-16x9.mp4", bytes: 10 + counter, mtimeMs: counter, ino: counter },
    manifest: {
      path: "out/probe/youtube-16x9.manifest.json",
      inputFingerprint: hex("f"),
      inputs: { metadata: hex("a"), cover: hex("b"), audio: hex("c"), preset: hex("d"), visualizer: hex("e") },
    },
    renderJobId: null,
    exportKind: "original",
    replaces: null,
    ...overrides,
  };
};

test("a library that does not exist yet reads as missing and empty, not as an error", async (t) => {
  const root = await libraryRoot(t);
  const read = readContentLibrary(root);
  assert.equal(read.status, "missing");
  assert.deepEqual(read.records, []);
});

test("appends are one record per line, in order, and read back exactly", async (t) => {
  const root = await libraryRoot(t);
  const records = [record(), record(), record()];
  for (const next of records) {
    const result = await appendContentLibraryRecord(() => next, root);
    assert.equal(result.appended, true);
    assert.equal(result.problem, null);
  }
  const text = await readFile(contentLibraryPath(root), "utf8");
  assert.equal(text.split("\n").filter(Boolean).length, 3);
  assert.ok(text.endsWith("\n"));
  const read = readContentLibrary(root);
  assert.equal(read.status, "complete");
  assert.deepEqual(read.records, records);
});

test("appending never rewrites an earlier record, byte for byte", async (t) => {
  const root = await libraryRoot(t);
  await appendContentLibraryRecord(() => record(), root);
  const before = await readFile(contentLibraryPath(root), "utf8");
  await appendContentLibraryRecord(() => record(), root);
  const after = await readFile(contentLibraryPath(root), "utf8");
  assert.ok(after.startsWith(before));
});

test("the builder sees the records already there, under the same lock as the append", async (t) => {
  const root = await libraryRoot(t);
  const first = record();
  await appendContentLibraryRecord(() => first, root);
  let seen: readonly ContentLibraryRecord[] = [];
  await appendContentLibraryRecord((existing) => {
    seen = existing;
    return record();
  }, root);
  assert.deepEqual(seen.map((r) => r.recordId), [first.recordId]);
});

test("the same completed export appended twice is recorded once", async (t) => {
  const root = await libraryRoot(t);
  const once = record();
  const first = await appendContentLibraryRecord(() => once, root);
  const second = await appendContentLibraryRecord(() => once, root);
  assert.equal(first.appended, true);
  assert.deepEqual([second.appended, second.duplicate], [false, true]);
  assert.equal(readContentLibrary(root).records.length, 1);
});

test("an append after an unterminated final line terminates it first, so both survive", async (t) => {
  const root = await libraryRoot(t);
  const first = record();
  // A complete record, but no newline — a short write that stopped on the brace.
  await writeFile(contentLibraryPath(root), JSON.stringify(first));
  const second = record();
  assert.equal((await appendContentLibraryRecord(() => second, root)).appended, true);
  const read = readContentLibrary(root);
  assert.equal(read.status, "complete");
  assert.deepEqual(read.records.map((r) => r.recordId), [first.recordId, second.recordId]);
});

test("a malformed middle line is reported, every valid record is still returned, and appends continue", async (t) => {
  const root = await libraryRoot(t);
  const first = record();
  await appendContentLibraryRecord(() => first, root);
  await appendFile(contentLibraryPath(root), "{this is not json\n");
  const last = record();
  assert.equal((await appendContentLibraryRecord(() => last, root)).appended, true);
  const read = readContentLibrary(root);
  assert.equal(read.status, "corrupt");
  assert.deepEqual(read.records.map((r) => r.recordId), [first.recordId, last.recordId]);
  assert.deepEqual(read.problems.map((p) => [p.line, p.kind]), [[2, "malformed"]]);
});

test("tail repair drops only an interrupted final fragment, and refuses anything else", async (t) => {
  const root = await libraryRoot(t);
  const kept = record();
  await appendContentLibraryRecord(() => kept, root);
  const fragment = JSON.stringify(record()).slice(0, 50);
  await appendFile(contentLibraryPath(root), fragment);
  assert.equal(readContentLibrary(root).status, "recovered_tail");

  const repaired = await repairContentLibraryTail(root);
  assert.deepEqual([repaired.repaired, repaired.discarded], [true, fragment]);
  assert.equal(readContentLibrary(root).status, "complete");
  assert.deepEqual(readContentLibrary(root).records.map((r) => r.recordId), [kept.recordId]);

  const nothing = await repairContentLibraryTail(root);
  assert.equal(nothing.repaired, false);
  assert.match(nothing.problem ?? "", /nothing to repair/);

  await appendFile(contentLibraryPath(root), "{broken\n");
  const before = await readFile(contentLibraryPath(root), "utf8");
  const refused = await repairContentLibraryTail(root);
  assert.equal(refused.repaired, false);
  assert.match(refused.problem ?? "", /corrupt/);
  assert.equal(await readFile(contentLibraryPath(root), "utf8"), before, "corruption is never rewritten");
});

test("concurrent appends from one process all land whole, and exactly once each", async (t) => {
  const root = await libraryRoot(t);
  const records = Array.from({ length: 25 }, () => record());
  const results = await Promise.all(records.map((next) => appendContentLibraryRecord(() => next, root)));
  assert.ok(results.every((result) => result.appended));
  const read = readContentLibrary(root);
  assert.equal(read.status, "complete");
  assert.deepEqual(new Set(read.records.map((r) => r.recordId)), new Set(records.map((r) => r.recordId)));
});

test("concurrent appends of one and the same export land exactly once", async (t) => {
  const root = await libraryRoot(t);
  const once = record();
  const results = await Promise.all(Array.from({ length: 10 }, () => appendContentLibraryRecord(() => once, root)));
  assert.equal(results.filter((result) => result.appended).length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 9);
  assert.equal(readContentLibrary(root).records.length, 1);
});

test("real processes appending at once never interleave or lose a record", async (t) => {
  const root = await libraryRoot(t);
  const processes = 4;
  const perProcess = 15;
  const children = Array.from({ length: processes }, (_, marker) =>
    fork(new URL("./library-process.mts", import.meta.url), [root, String(marker), String(perProcess)]),
  );
  t.after(() => children.forEach((child) => child.connected && child.kill()));

  await Promise.all(children.map((child) => once(child, "message")));
  const done = children.map(
    (child) =>
      new Promise<{ appended: string[]; problems: string[] }>((resolve) =>
        child.on("message", (message: { type: string; appended: string[]; problems: string[] }) => {
          if (message.type === "done") resolve(message);
        }),
      ),
  );
  children.forEach((child) => child.send("go"));
  const outcomes = await Promise.all(done);

  assert.deepEqual(outcomes.flatMap((outcome) => outcome.problems), []);
  const read = parseContentLibrary(readFileSync(contentLibraryPath(root), "utf8"));
  assert.equal(read.status, "complete");
  assert.equal(read.records.length, processes * perProcess);
});

test("an operator can clear a lock left by a dead process, and nothing clears a live one", async (t) => {
  const root = await libraryRoot(t);
  const lock = path.join(root, ".library.lock");

  assert.match(releaseContentLibraryLock(root).problem ?? "", /no content library lock/);

  writeFileSync(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), token: "live", createdAt: new Date().toISOString() }));
  const refused = releaseContentLibraryLock(root);
  assert.equal(refused.released, false);
  assert.match(refused.problem ?? "", /still holds the lock/);

  // A pid that cannot be alive on this host.
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 7, hostname: hostname(), token: "dead", createdAt: new Date().toISOString() }));
  assert.equal(releaseContentLibraryLock(root).released, true);

  // And a dead owner's lock never blocks an append for long: it is reclaimed.
  writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 7, hostname: hostname(), token: "dead", createdAt: new Date().toISOString() }));
  assert.equal((await appendContentLibraryRecord(() => record(), root)).appended, true);
});

test("a library that cannot be written reports a problem instead of throwing", async (t) => {
  const root = await libraryRoot(t);
  const notADirectory = path.join(root, "a-file");
  await writeFile(notADirectory, "x");
  const result = await appendContentLibraryRecord(() => record(), notADirectory);
  assert.equal(result.appended, false);
  assert.ok(result.problem);
});
