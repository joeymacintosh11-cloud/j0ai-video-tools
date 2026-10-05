import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { after, type TestContext } from "node:test";
import { handleRequest } from "../server/app.ts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import type { RenderPresetId } from "../core/domain/video/renderPresets.ts";
import { contentLibraryPath, readContentLibrary } from "../services/library/contentLibraryLog.ts";
import { publishRecordedExport, trackSnapshotFromProps } from "../services/library/recordExport.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { fixture } from "./fixtures.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

/**
 * The content library over HTTP (server/routes/contentLibrary.ts), through
 * the real app router.
 *
 * The library is redirected to a temp directory for the whole file — the
 * server reads it through `TOSHI_CONTENT_LIBRARY_DIR`, exactly as a forked
 * render worker would — and the render journal likewise, because a re-export
 * starts a real batch on the real render manager (with fork() replaced, so no
 * Chromium ever launches).
 */

await isolateRenderJournalForThisFile();

const previousLibraryDir = process.env.TOSHI_CONTENT_LIBRARY_DIR;
const libraryDir = await mkdtemp(path.join(tmpdir(), "toshi-library-api-"));
process.env.TOSHI_CONTENT_LIBRARY_DIR = libraryDir;
after(async () => {
  if (previousLibraryDir === undefined) delete process.env.TOSHI_CONTENT_LIBRARY_DIR;
  else process.env.TOSHI_CONTENT_LIBRARY_DIR = previousLibraryDir;
  await rm(libraryDir, { recursive: true, force: true });
});

const api = async (t: TestContext) => {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};

const track = async (t: TestContext) => {
  const f = await fixture(t);
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));
  const publish = async (presetId: RenderPresetId, renderer?: "after-effects") => {
    const props = buildTrackProps({
      slug: f.slug,
      metadata: parseTrackMetadata(JSON.parse(await readFile(f.metadata, "utf8")), "fixture"),
      analysisAvailable: true,
    });
    const outcome = await publishRecordedExport({
      slug: f.slug,
      presetId,
      inputs: fingerprintInputs(props, presetId, undefined, renderer, renderer && AE_TEMPLATE),
      track: trackSnapshotFromProps(f.slug, props),
      ...(renderer ? { renderer, template: AE_TEMPLATE } : {}),
      jobId: null,
      produce: async (file) => writeFile(file, `video ${randomUUID()}`),
    });
    assert.equal(outcome.appended, true);
    return outcome.record!;
  };
  return { f, publish };
};

const AE_TEMPLATE = { composition: "Toshi Visualizer", version: "aep-sha256:test;prep:1;mode:manual" };

const get = async (url: string) => {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
};

test("the list endpoint filters by track, reports per-format coverage, and bounds every response", async (t) => {
  const base = await api(t);
  const { f, publish } = await track(t);
  await publish("youtube-16x9");
  await publish("youtube-16x9");
  await publish("square-1x1");

  const { status, body } = await get(`${base}/api/content-library?track=${f.slug}`);
  assert.equal(status, 200);
  assert.equal(body.data.matched, 3);
  assert.equal(body.data.limit, 50);
  // Whatever this machine's own delivery settings say (read, never written).
  assert.ok(["not_configured", "available", "unavailable"].includes(body.data.deliveries));
  assert.deepEqual(body.data.entries.map((entry: { status: string }) => entry.status).sort(), ["current", "current", "superseded"]);
  assert.deepEqual(
    body.data.formats.map((format: { presetId: string; versions: number }) => [format.presetId, format.versions]),
    [["youtube-16x9", 2], ["vertical-9x16", 0], ["square-1x1", 1]],
  );
  assert.ok(body.data.knownTracks.some((known: { slug: string }) => known.slug === f.slug));

  const superseded = await get(`${base}/api/content-library?track=${f.slug}&status=superseded&kind=original`);
  assert.equal(superseded.body.data.entries.length, 1);

  const oldest = await get(`${base}/api/content-library?track=${f.slug}&preset=youtube-16x9&order=oldest&limit=1`);
  assert.equal(oldest.body.data.entries.length, 1);
  assert.equal(oldest.body.data.entries[0].status, "superseded");
  assert.equal(oldest.body.data.matched, 2);
});

test("invalid filters are refused with a 400 and a reason, never silently ignored", async (t) => {
  const base = await api(t);
  for (const query of ["status=done", "kind=remix", "limit=0", "limit=9999", "from=yesterday", "track=..%2F..", "order=random"]) {
    const { status, body } = await get(`${base}/api/content-library?${query}`);
    assert.equal(status, 400, query);
    assert.equal(body.error.code, "INVALID_REQUEST", query);
  }
});

test("one record can be inspected, with 404 for an unknown id and 400 for a malformed one", async (t) => {
  const base = await api(t);
  const { publish } = await track(t);
  const first = await publish("vertical-9x16");
  const second = await publish("vertical-9x16");

  const detail = await get(`${base}/api/content-library/${first.recordId}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.entry.status, "superseded");
  assert.equal(detail.body.data.entry.supersededBy, second.recordId);
  assert.deepEqual(detail.body.data.versions.map((v: { record: { recordId: string } }) => v.record.recordId), [first.recordId, second.recordId]);

  const unknown = await get(`${base}/api/content-library/${"0".repeat(32)}`);
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "LIBRARY_RECORD_NOT_FOUND");

  const malformed = await get(`${base}/api/content-library/not-an-id`);
  assert.equal(malformed.status, 400);
});

test("a superseded version refuses to re-export, and changes nothing", async (t) => {
  const base = await api(t);
  const { publish } = await track(t);
  const first = await publish("youtube-16x9");
  await publish("youtube-16x9");
  const before = await readFile(contentLibraryPath(), "utf8");

  const response = await fetch(`${base}/api/content-library/${first.recordId}/reexport`, { method: "POST" });
  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, "LIBRARY_RECORD_NOT_CURRENT");
  assert.equal(await readFile(contentLibraryPath(), "utf8"), before);
});

test("re-exporting the current version queues exactly one normal render, and never touches the original record", async (t) => {
  const childProcess = (await import("node:child_process")).default;
  const { Worker } = await import("./managerHarness.mts");
  const { renderManager } = await import("../services/workflows/renderManager.ts");
  const worker = new Worker();
  worker.pid = 4242;
  t.mock.method(childProcess, "fork", () => worker);
  syncBuiltinESMExports();

  const base = await api(t);
  const { f, publish } = await track(t);
  const current = await publish("square-1x1");
  const before = await readFile(contentLibraryPath(), "utf8");
  let batchId: string | null = null;
  t.after(() => {
    if (batchId) renderManager.cancelBatch(batchId);
    worker.emit("message", { type: "cancelled" });
    worker.emit("exit", 0, null);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const response = await fetch(`${base}/api/content-library/${current.recordId}/reexport`, { method: "POST" });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  batchId = body.data.batch.id;
  assert.equal(body.data.recordId, current.recordId);
  assert.deepEqual(
    body.data.batch.jobs.map((job: { slug: string; presetId: string }) => [job.slug, job.presetId]),
    [[f.slug, "square-1x1"]],
  );

  // A second click while that render is in flight is refused up front, and
  // leaves no empty batch behind.
  const batches = renderManager.listBatches().length;
  const again = await fetch(`${base}/api/content-library/${current.recordId}/reexport`, { method: "POST" });
  assert.equal(again.status, 409);
  assert.equal((await again.json()).error.code, "RENDER_ALREADY_ACTIVE");
  assert.equal(renderManager.listBatches().length, batches);

  // Queueing a re-export writes nothing to the library; only a completed
  // render does, as a new record.
  assert.equal(await readFile(contentLibraryPath(), "utf8"), before);
  assert.equal(readContentLibrary().records.filter((r) => r.track.slug === f.slug).length, 1);
});

test("re-exporting an After Effects version queues an After Effects render, never a Remotion one", async (t) => {
  const childProcess = (await import("node:child_process")).default;
  const { Worker } = await import("./managerHarness.mts");
  const { renderManager } = await import("../services/workflows/renderManager.ts");
  const worker = new Worker();
  worker.pid = 4243;
  t.mock.method(childProcess, "fork", () => worker);
  syncBuiltinESMExports();

  const base = await api(t);
  const { f, publish } = await track(t);
  const current = await publish("youtube-16x9", "after-effects");
  assert.equal(current.template.renderer, "after-effects");
  let batchId: string | null = null;
  t.after(() => {
    if (batchId) renderManager.cancelBatch(batchId);
    worker.emit("message", { type: "cancelled" });
    worker.emit("exit", 0, null);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const response = await fetch(`${base}/api/content-library/${current.recordId}/reexport`, { method: "POST" });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  batchId = body.data.batch.id;
  assert.deepEqual(
    body.data.batch.jobs.map((job: { slug: string; presetId: string; engine: string }) => [job.slug, job.presetId, job.engine]),
    [[f.slug, "youtube-16x9", "after-effects"]],
  );
});

test("an empty library answers with an empty, well-formed view", async (t) => {
  const base = await api(t);
  const { status, body } = await get(`${base}/api/content-library?track=no-such-track`);
  assert.equal(status, 200);
  assert.deepEqual(body.data.entries, []);
  assert.equal(body.data.summary.total, 0);
  assert.equal(body.data.formats.every((format: { versions: number }) => format.versions === 0), true);
});
