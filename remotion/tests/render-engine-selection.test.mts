import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { TrackError } from "../core/domain/tracks/errors.ts";
import {
  parseRenderJournalLine,
  reconstructRenderJournal,
  RENDER_JOURNAL_SCHEMA_VERSION,
} from "../core/domain/render/renderJournal.ts";
import { handleRequest } from "../server/app.ts";
import { readRenderJournal } from "../services/render/renderJournalLog.ts";
import { fixture } from "./fixtures.mts";
import { manager, Worker } from "./managerHarness.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

/**
 * A render job's engine (core/domain/video/renderers.ts) travels with it: from
 * the API or the render manager, through the journal, to the worker process
 * that resolves it in adapters/renderEngines.mts. Absent everywhere means
 * Remotion, exactly as before engines were selectable.
 */

await isolateRenderJournalForThisFile();

const WORKER = fileURLToPath(new URL("../services/workflows/render-worker.mts", import.meta.url));

/** A manager whose fork() records the argv each job was started with. */
const recordingManager = async (t: TestContext) => {
  const forks: (readonly string[])[] = [];
  const instance = await manager(t, (_modulePath, args) => {
    forks.push(args);
    const worker = new Worker();
    worker.pid = 4242;
    return worker;
  });
  return { manager: instance, forks };
};

const slug = () => `engine-${randomUUID()}`;

/* ------------------------------------------------------------------ *
 * Render manager
 * ------------------------------------------------------------------ */

test("a render with no engine named is a Remotion job, and the worker is told so", async (t) => {
  const { manager: m, forks } = await recordingManager(t);
  const track = slug();
  const job = m.startRender(track, "square-1x1");

  assert.equal(job.engine, "remotion");
  assert.deepEqual(forks, [[track, "square-1x1", job.id, "remotion"]]);
  m.cancelRender(job.id);
});

test("an explicitly selected engine is carried on the job and handed to the worker", async (t) => {
  const { manager: m, forks } = await recordingManager(t);
  const track = slug();

  const explicit = m.startRender(track, "youtube-16x9", "remotion");
  assert.equal(explicit.engine, "remotion");

  // The manager validates the id; whether this installation has the engine is
  // the API's and the worker's to check. A reserved renderer still travels.
  const reserved = m.startRender(track, "vertical-9x16", "after-effects");
  assert.equal(reserved.engine, "after-effects");
  assert.equal(m.getJob(reserved.id).engine, "after-effects");

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(forks[0], [track, "youtube-16x9", explicit.id, "remotion"]);
  m.cancelRender(reserved.id);
  m.cancelRender(explicit.id);
});

test("an unknown engine is rejected before anything is queued", async (t) => {
  const { manager: m, forks } = await recordingManager(t);
  assert.throws(
    () => m.startRender(slug(), "square-1x1", "blender"),
    (error: unknown) => error instanceof TrackError && error.code === "INVALID_RENDERER",
  );
  assert.throws(
    () => m.startBatch([{ slug: slug(), preset: "square-1x1", engine: "blender" as never }]),
    (error: unknown) => error instanceof TrackError && error.code === "INVALID_RENDERER",
  );
  assert.deepEqual(m.listJobs(), []);
  assert.deepEqual(forks, []);
});

test("batch targets carry their own engine, and skipped targets echo it only when named", async (t) => {
  const { manager: m, forks } = await recordingManager(t);
  const track = slug();

  const { batch, skipped } = m.startBatch([
    { slug: track, preset: "square-1x1", engine: "premiere" },
    { slug: track, preset: "vertical-9x16" },
    { slug: track, preset: "square-1x1", engine: "premiere" },
    { slug: track, preset: "vertical-9x16" },
  ]);

  assert.deepEqual(
    batch.jobs.map((job) => [job.presetId, job.engine]),
    [
      ["square-1x1", "premiere"],
      ["vertical-9x16", "remotion"],
    ],
  );
  assert.deepEqual(skipped, [
    { slug: track, preset: "square-1x1", engine: "premiere" },
    { slug: track, preset: "vertical-9x16" },
  ]);
  assert.deepEqual(forks[0], [track, "square-1x1", batch.jobs[0].id, "premiere"]);
  m.cancelBatch(batch.id);
});

/* ------------------------------------------------------------------ *
 * Render journal
 * ------------------------------------------------------------------ */

// Untyped on purpose: the tests feed it malformed values too.
const journalLine = (fields: Record<string, unknown>): string =>
  JSON.stringify({
    schemaVersion: RENDER_JOURNAL_SCHEMA_VERSION,
    eventId: randomUUID(),
    jobId: "job-1",
    batchId: null,
    slug: "track",
    presetId: "square-1x1",
    state: "queued",
    recordedAt: new Date(0).toISOString(),
    bootId: "boot",
    error: null,
    ...fields,
  });

test("the journal records each job's engine; events from before engines read back as Remotion", () => {
  const parse = (line: string) => {
    const parsed = parseRenderJournalLine(line);
    assert.ok(parsed.ok, line);
    return parsed.event;
  };

  const legacy = parse(journalLine({ jobId: "old" }));
  assert.equal("engine" in legacy, false);
  const modern = parse(journalLine({ jobId: "new", engine: "premiere" }));
  assert.equal(modern.engine, "premiere");
  const future = parse(journalLine({ jobId: "future", engine: "cloud-farm" }));

  const { jobs } = reconstructRenderJournal([legacy, modern, future]);
  assert.equal(jobs.get("old")?.engine, "remotion");
  assert.equal(jobs.get("new")?.engine, "premiere");
  assert.equal(jobs.get("future")?.engine, null, "an unknown renderer is not guessed");

  assert.equal(parseRenderJournalLine(journalLine({ engine: "" })).ok, false);
  assert.equal(parseRenderJournalLine(journalLine({ engine: 7 })).ok, false);
});

test("the render manager writes the job's engine into every journal event", async (t) => {
  const { manager: m } = await recordingManager(t);
  const job = m.startRender(slug(), "square-1x1", "premiere");
  m.cancelRender(job.id);
  const { waitForRenderJournalIdle } = await import("../services/workflows/renderJournal.ts");
  await waitForRenderJournalIdle();

  const events = readRenderJournal().events.filter((event) => event.jobId === job.id);
  assert.ok(events.length >= 2);
  assert.deepEqual(new Set(events.map((event) => event.engine)), new Set(["premiere"]));
});

/* ------------------------------------------------------------------ *
 * HTTP API
 * ------------------------------------------------------------------ */

/** The real server, with the real render manager's fork() recorded rather than run. */
const api = async (t: TestContext) => {
  const childProcess = (await import("node:child_process")).default;
  const forks: (readonly string[])[] = [];
  t.mock.method(childProcess, "fork", (_modulePath: string, args: readonly string[]) => {
    forks.push(args);
    const worker = new Worker();
    worker.pid = 4343;
    return worker;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

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
  const base = `http://127.0.0.1:${address.port}`;

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, json: await response.json() };
  };

  return { post, forks };
};

const renderableTrack = async (t: TestContext) => {
  const f = await fixture(t);
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  t.after(() => fs.rm(f.outputDir, { recursive: true, force: true }));
  return f;
};

test("POST /api/tracks/:slug/render defaults to Remotion and accepts an explicit engine", async (t) => {
  const { post, forks } = await api(t);
  const { renderManager } = await import("../services/workflows/renderManager.ts");
  const f = await renderableTrack(t);

  const implicit = await post(`/api/tracks/${f.slug}/render`, { preset: "square-1x1" });
  assert.equal(implicit.status, 200);
  assert.equal(implicit.json.data.job.engine, "remotion");

  const explicit = await post(`/api/tracks/${f.slug}/render`, { preset: "vertical-9x16", engine: "remotion" });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.json.data.job.engine, "remotion");

  assert.deepEqual(forks[0], [f.slug, "square-1x1", implicit.json.data.jobId, "remotion"]);
  renderManager.cancelRender(explicit.json.data.jobId);
  renderManager.cancelRender(implicit.json.data.jobId);
});

test("the API rejects an unknown or unavailable engine with a 400 and queues nothing", async (t) => {
  const { post, forks } = await api(t);
  const f = await renderableTrack(t);

  const unknown = await post(`/api/tracks/${f.slug}/render`, { engine: "blender" });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, "INVALID_RENDERER");

  const unavailable = await post(`/api/tracks/${f.slug}/render`, { engine: "premiere" });
  assert.equal(unavailable.status, 400);
  assert.equal(unavailable.json.error.code, "RENDERER_UNAVAILABLE");
  assert.match(unavailable.json.error.message, /"premiere" render engine is not available/);

  const batch = await post("/api/render-batches", {
    targets: [
      { slug: f.slug, preset: "square-1x1" },
      { slug: f.slug, preset: "vertical-9x16", engine: "after-effects" },
    ],
  });
  assert.equal(batch.status, 400);
  assert.equal(batch.json.error.code, "RENDERER_UNAVAILABLE");

  assert.deepEqual(forks, []);
});

/* ------------------------------------------------------------------ *
 * Render worker (a real process, stopped before any rendering)
 * ------------------------------------------------------------------ */

const workerError = async (args: readonly string[]) => {
  const child = fork(WORKER, args, { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const messages: { type: string; error?: { code: string; message: string } }[] = [];
  child.on("message", (message) => messages.push(message as (typeof messages)[number]));
  const [code] = await once(child, "exit");
  return { code, error: messages.find((message) => message.type === "error")?.error, messages };
};

test("the render worker resolves the job's engine and reports an unavailable one as a job error", async () => {
  const unavailable = await workerError([slug(), "square-1x1", "job-1", "premiere"]);
  assert.equal(unavailable.code, 1);
  assert.equal(unavailable.error?.code, "RENDERER_UNAVAILABLE");
  // Resolved before any work: the job never reached "preparing".
  assert.equal(unavailable.messages.some((message) => message.type === "status"), false);

  const unknown = await workerError([slug(), "square-1x1", "job-2", "blender"]);
  assert.equal(unknown.error?.code, "INVALID_RENDERER");
});

test("a worker started without an engine (an older caller) still resolves Remotion", async () => {
  // A missing track fails after the engine resolved, proving it got that far.
  const { error, messages } = await workerError([slug(), "square-1x1", "job-3"]);
  assert.ok(messages.some((message) => message.type === "status"));
  assert.equal(error?.code, "TRACK_NOT_FOUND");
});
