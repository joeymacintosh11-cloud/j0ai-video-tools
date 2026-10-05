import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { hostname } from "node:os";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { parsePublicationHistory, queryPublicationHistory } from "../core/domain/publishing/publicationHistory.ts";
import {
  parsePublicationReceipt,
  receiptMismatch,
  type PublicationReceipt,
} from "../core/domain/publishing/publicationReceipt.ts";
import { makeCancelSignal } from "../core/ports/renderEngine.ts";
import { createLocalMockDestination } from "../adapters/publishing/local-mock/localMockDestination.mts";
import {
  appendPublicationReceipt,
  attemptIdentity,
  destinationWorkspace,
  readPublicationReceipts,
  readPublishJobFile,
  receiptIdFor,
  receiptsPath,
} from "../services/publishing/publishingStore.ts";
import { ALL_FORMATS, isolatePublishing, metadata, publishingTrack, service } from "./publishingHarness.mts";
import { releaseJsonlLock } from "../services/storage/jsonlAppendLog.ts";

const FINGERPRINT = "a".repeat(64);
const valid = (overrides: Partial<PublicationReceipt> = {}): PublicationReceipt => {
  const { attemptId, idempotencyKey } = attemptIdentity("pub_0123456789abcdef01234567", 1);
  return {
    schemaVersion: 1,
    receiptId: receiptIdFor(idempotencyKey),
    jobId: "pub_0123456789abcdef01234567",
    attemptId,
    idempotencyKey,
    destination: { id: "test-mock", accountId: "tester" },
    publicationId: "mock-0123456789abcdef0123",
    url: "mock://test-mock/mock-0123456789abcdef0123",
    mode: "video",
    publishedAt: "2026-10-01T12:00:00.000Z",
    recordedAt: "2026-10-01T12:00:01.000Z",
    source: {
      slug: "a-track",
      presetId: "youtube-16x9",
      renderer: "after-effects",
      inputFingerprint: FINGERPRINT,
      renderedAt: "2026-09-30T10:00:00.000Z",
      output: { bytes: 10, mtimeMs: 1, ino: 2 },
      outputLabel: "out/a-track/after-effects/youtube-16x9.mp4",
    },
    metadata: metadata(),
    ...overrides,
  };
};

test("receipt append reclamation fences a competing operator before clearing the dead owner", async (t) => {
  const iso = await isolatePublishing(t);
  fs.mkdirSync(iso.root, { recursive: true });
  const lock = path.join(iso.root, ".receipts.lock");
  fs.writeFileSync(lock, JSON.stringify({ pid: 2 ** 22 + 12345, hostname: hostname(), token: "dead" }));
  const original = fs.unlinkSync;
  let competing: ReturnType<typeof releaseJsonlLock> | undefined;
  t.mock.method(fs, "unlinkSync", (file: Parameters<typeof fs.unlinkSync>[0]) => {
    if (file === lock && competing === undefined) {
      competing = releaseJsonlLock(iso.root, ".receipts.lock", "receipts");
      assert.equal(competing.released, false, "another reclaimer must not enter the unlink window");
    }
    return original(file);
  });
  syncBuiltinESMExports();
  try {
    await appendPublicationReceipt(valid());
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
  assert.match(competing!.problem!, /being reconciled/);
  assert.equal(readPublicationReceipts().receipts.length, 1);
  assert.equal(fs.existsSync(`${lock}.reclaim`), false);
});

test("a well-formed receipt parses; malformed receipts are rejected with a reason", () => {
  assert.equal(parsePublicationReceipt(valid()).problem, null);
  const cases: [string, unknown][] = [
    ["not an object", "receipt"],
    ["schemaVersion", { ...valid(), schemaVersion: 2 }],
    ["receiptId", { ...valid(), receiptId: "rcp_short" }],
    ["jobId", { ...valid(), jobId: "../../etc" }],
    ["publicationId", { ...valid(), publicationId: "has spaces" }],
    ["url", { ...valid(), url: "https://user:pw@example.com/v" }],
    ["url", { ...valid(), url: "https://example.com/v?access_token=x" }],
    ["url", { ...valid(), url: "file:///Users/me/video.mp4" }],
    ["mode", { ...valid(), mode: "story" }],
    ["publishedAt", { ...valid(), publishedAt: "yesterday" }],
    ["source", { ...valid(), source: { ...valid().source, renderer: "final-cut" } }],
    ["source", { ...valid(), source: { ...valid().source, inputFingerprint: "nope" } }],
    ["source", { ...valid(), source: { ...valid().source, renderer: undefined } }],
    ["metadata", { ...valid(), metadata: { ...metadata(), visibility: "everyone" } }],
    ["credential", { ...valid(), destination: { id: "test-mock", accountId: "tester", refreshToken: "x" } }],
  ];
  for (const [expected, raw] of cases) {
    const parsed = parsePublicationReceipt(raw);
    assert.equal(parsed.receipt, null, expected);
    assert.match(parsed.problem!, new RegExp(expected === "not an object" ? "object" : expected, "i"), expected);
  }
});

test("receipt history: malformed and duplicate lines are reported, never hide valid receipts", () => {
  const first = valid();
  const { attemptId, idempotencyKey } = attemptIdentity("pub_0123456789abcdef0123456a", 1);
  const second = valid({ jobId: "pub_0123456789abcdef0123456a", attemptId, idempotencyKey, receiptId: receiptIdFor(idempotencyKey), recordedAt: "2026-10-02T00:00:00.000Z", source: { ...valid().source, renderer: "remotion", outputLabel: "out/a-track/youtube-16x9.mp4" } });
  const text = [JSON.stringify(first), "{not json", JSON.stringify({ ...first, url: "file:///x" }), JSON.stringify(first), JSON.stringify(second), '{"partial'].join("\n");
  const read = parsePublicationHistory(text);
  assert.equal(read.status, "damaged");
  assert.deepEqual(read.receipts.map((r) => r.jobId), [first.jobId, second.jobId]);
  assert.deepEqual(read.problems.map((p) => [p.line, p.kind]), [[2, "malformed"], [3, "invalid"], [4, "duplicate"], [6, "truncated"]]);
  assert.deepEqual(queryPublicationHistory(read.receipts).map((r) => r.jobId), [second.jobId, first.jobId], "newest first");
  assert.deepEqual(queryPublicationHistory(read.receipts, { renderer: "after-effects" }).map((r) => r.jobId), [first.jobId]);
  assert.deepEqual(queryPublicationHistory(read.receipts, { track: "other" }), []);
  assert.equal(parsePublicationHistory("").status, "complete");
});

test("the same attempt never yields two receipts; another attempt of the same job is refused", async (t) => {
  await isolatePublishing(t);
  const receipt = valid();
  assert.deepEqual(await appendPublicationReceipt(receipt), { appended: true, receipt });
  assert.deepEqual(await appendPublicationReceipt(receipt), { appended: false, receipt });
  await assert.rejects(appendPublicationReceipt({ ...receipt, publicationId: "mock-ffffffffffffffffffff" }), /conflicting receipt/);
  const { attemptId, idempotencyKey } = attemptIdentity(receipt.jobId, 2);
  await assert.rejects(
    appendPublicationReceipt({ ...receipt, attemptId, idempotencyKey, receiptId: receiptIdFor(idempotencyKey) }),
    /already has a publication receipt/,
  );
  const concurrent = await Promise.all([1, 2, 3].map((n) => {
    const id = attemptIdentity(`pub_0123456789abcdef0123450${n}`, 1);
    return appendPublicationReceipt({ ...receipt, jobId: `pub_0123456789abcdef0123450${n}`, ...id, receiptId: receiptIdFor(id.idempotencyKey) });
  }));
  assert.ok(concurrent.every((result) => result.appended));
  assert.equal(readPublicationReceipts().receipts.length, 4);
  assert.equal(readPublicationReceipts().status, "complete");

  // Attempt identity is deterministic per (job, number) and distinct across attempts.
  assert.deepEqual(attemptIdentity(receipt.jobId, 1), attemptIdentity(receipt.jobId, 1));
  assert.notDeepEqual(attemptIdentity(receipt.jobId, 1), attemptIdentity(receipt.jobId, 2));
  assert.notDeepEqual(attemptIdentity(receipt.jobId, 1), attemptIdentity("pub_0123456789abcdef0123456a", 1));
});

test("a damaged receipt log is reported and still appended to on a fresh line", async (t) => {
  await isolatePublishing(t);
  await appendPublicationReceipt(valid());
  await writeFile(receiptsPath(), `${JSON.stringify(valid())}\n{"cut`, { flag: "w" });
  const { attemptId, idempotencyKey } = attemptIdentity("pub_0123456789abcdef0123456b", 1);
  await appendPublicationReceipt(valid({ jobId: "pub_0123456789abcdef0123456b", attemptId, idempotencyKey, receiptId: receiptIdFor(idempotencyKey) }));
  const read = readPublicationReceipts();
  assert.equal(read.receipts.length, 2);
  assert.deepEqual(read.problems.map((p) => p.kind), ["malformed"]);
});

test("the mock destination is idempotent for one attempt and distinct across attempts", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const { publishing } = service();
  const job = readPublishJobFile((await publishing.createJob({ destinationId: "test-mock", source: { slug: f.slug, presetId: "youtube-16x9", renderer: "remotion" }, metadata: metadata() })).jobId);
  const destination = createLocalMockDestination({ descriptor: ALL_FORMATS, workspace: () => destinationWorkspace("test-mock") });
  const context = { cancelSignal: makeCancelSignal().cancelSignal, log: () => {} };
  const requestFor = (n: number) => ({
    jobId: job.jobId, ...attemptIdentity(job.jobId, n), accountId: "tester", mode: "video" as const,
    metadata: job.metadata, source: job.source!, sourceFile: path.join(f.outputDir, "youtube-16x9.mp4"), thumbnailFile: null,
  });
  const publishOnce = async (n: number) => {
    const prepared = await destination.prepare(requestFor(n), context);
    try {
      return await destination.publish(prepared, context);
    } finally {
      await prepared.dispose();
    }
  };
  const [a, b] = await Promise.all([publishOnce(1), publishOnce(1)]);
  assert.equal(a.outcome, "published");
  assert.deepEqual(a, b, "the same attempt twice is the same publication");
  const c = await publishOnce(2);
  assert.equal(c.outcome, "published");
  assert.notEqual(c.outcome === "published" && c.publicationId, a.outcome === "published" && a.publicationId);
  const dirs = (await readdir(path.join(destinationWorkspace("test-mock"), "publications"))).filter((name) => !name.startsWith("."));
  assert.equal(dirs.length, 2);
  const id = a.outcome === "published" ? a.publicationId : "";
  assert.ok(dirs.includes(id));
  assert.deepEqual(await destination.inspect(id, "tester"), { publicationId: id, state: "published", url: `mock://test-mock/${id}` });
  assert.equal(await destination.inspect("mock-ffffffffffffffffffff", "tester"), null);
  assert.equal(await destination.inspect("../../etc", "tester"), null);
  assert.deepEqual(await destination.recover!({ jobId: job.jobId, ...attemptIdentity(job.jobId, 3), accountId: "tester", publicationId: null }), { outcome: "not_published" });
});

test("receiptMismatch binds a receipt to its job's attempt, destination, account and pinned export", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const { publishing } = service();
  const published = await publishing.execute((await publishing.createJob({ destinationId: "test-mock", source: { slug: f.slug, presetId: "youtube-16x9", renderer: "remotion" }, metadata: metadata() })).jobId);
  const job = readPublishJobFile(published.jobId);
  const receipt = published.receipt!;
  assert.equal(receiptMismatch(job, receipt), null);
  assert.match(receiptMismatch(job, { ...receipt, jobId: "pub_ffffffffffffffffffffffff" })!, /another job/);
  assert.match(receiptMismatch(job, { ...receipt, attemptId: "att_ffffffffffffffffffffffff" })!, /another attempt/);
  assert.match(receiptMismatch(job, { ...receipt, destination: { id: "other", accountId: "tester" } })!, /destination/);
  assert.match(receiptMismatch(job, { ...receipt, destination: { id: "test-mock", accountId: "x" } })!, /account/);
  assert.match(receiptMismatch(job, { ...receipt, source: { ...receipt.source, renderer: "after-effects" } })!, /pinned export/);
  assert.match(receiptMismatch(job, { ...receipt, source: { ...receipt.source, inputFingerprint: FINGERPRINT } })!, /pinned export/);
});
