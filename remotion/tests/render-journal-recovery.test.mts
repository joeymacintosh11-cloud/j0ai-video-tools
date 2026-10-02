import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { handleRequest } from "../server/app.ts";
import { RENDER_MANAGER_BOOT_ID } from "../services/workflows/renderJournal.ts";
import {
  RENDER_JOURNAL_SCHEMA_VERSION,
  type RenderJournalEvent,
} from "../core/domain/render/renderJournal.ts";
import { appendRenderJournalEvent } from "../services/render/renderJournalLog.ts";
import { fixture } from "./fixtures.mts";
import { Worker } from "./managerHarness.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

await isolateRenderJournalForThisFile();

/**
 * What GET /api/renders/:id (and its neighbors, cancel and SSE) actually say
 * about a job the live render manager does not have — the observable surface
 * of the durable render journal (core/domain/render/renderJournal.ts,
 * services/render/renderJournalLog.ts, services/workflows/renderJournal.ts).
 *
 * Uses the real singleton `renderManager` behind the real HTTP routes, the
 * same way api-integration.test.mts and destination-fix-plan-render.test.mts
 * do, because those routes are not written to accept an injected manager —
 * the render worker is mocked, the journal directory is redirected to a
 * throwaway temp dir for this whole file (see renderJournalTestIsolation.mts)
 * and never this repository's real out/.render-journal/.
 */

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
  return { base: `http://127.0.0.1:${address.port}` };
};

const journalEvent = (overrides: Partial<RenderJournalEvent>): RenderJournalEvent => ({
  schemaVersion: RENDER_JOURNAL_SCHEMA_VERSION,
  eventId: randomUUID(),
  jobId: randomUUID(),
  batchId: null,
  slug: "probe",
  presetId: "youtube-16x9",
  state: "queued",
  recordedAt: new Date().toISOString(),
  bootId: RENDER_MANAGER_BOOT_ID,
  error: null,
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * Terminal / interrupted recovery, same process
 * ------------------------------------------------------------------ */

test("a terminal job the live manager has forgotten is answered historically, from this process's own boot", async (t) => {
  const jobId = randomUUID();
  await appendRenderJournalEvent(journalEvent({ jobId, state: "queued" }));
  await appendRenderJournalEvent(journalEvent({ jobId, state: "preparing" }));
  await appendRenderJournalEvent(journalEvent({ jobId, state: "completed" }));

  const { base } = await api(t);
  const response = await fetch(`${base}/api/renders/${jobId}`);
  assert.equal(response.status, 200);
  const body = (await response.json()).data;
  assert.equal(body.status, "completed");
  assert.equal(body.historical, true);
  // Same boot id as the answering process: not a restart, just aged out of
  // renderManager's own bounded in-memory history.
  assert.equal(body.recoveredAfterRestart, false);
});

test("a failed and a cancelled job both recover their real terminal status, not a guess", async (t) => {
  const { base } = await api(t);

  const failedId = randomUUID();
  await appendRenderJournalEvent(journalEvent({ jobId: failedId, state: "queued" }));
  await appendRenderJournalEvent(
    journalEvent({ jobId: failedId, state: "failed", error: { code: "RENDER_FAILED", message: "boom" } }),
  );
  const failed = (await (await fetch(`${base}/api/renders/${failedId}`)).json()).data;
  assert.equal(failed.status, "failed");
  assert.equal(failed.historical, true);
  assert.equal(failed.error.message, "boom");

  const cancelledId = randomUUID();
  await appendRenderJournalEvent(journalEvent({ jobId: cancelledId, state: "queued" }));
  await appendRenderJournalEvent(journalEvent({ jobId: cancelledId, state: "cancelled" }));
  const cancelled = (await (await fetch(`${base}/api/renders/${cancelledId}`)).json()).data;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.historical, true);
});

test("an unknown job id — no journal entry at all — is still a plain 404, unchanged", async (t) => {
  const { base } = await api(t);
  const response = await fetch(`${base}/api/renders/${randomUUID()}`);
  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, "RENDER_JOB_NOT_FOUND");
});

test("a non-terminal record from this same process's own boot is still reported interrupted, never as live", async (t) => {
  // Not a real scenario renderManager itself produces (a job it started is
  // always in its live map until settled), but the honest answer for any
  // non-terminal record with no live owner, from whatever boot: never queued/
  // preparing/rendering, which would fabricate an active job.
  const jobId = randomUUID();
  await appendRenderJournalEvent(journalEvent({ jobId, state: "queued" }));
  await appendRenderJournalEvent(journalEvent({ jobId, state: "preparing" }));

  const { base } = await api(t);
  const body = (await (await fetch(`${base}/api/renders/${jobId}`)).json()).data;
  assert.equal(body.status, "interrupted");
  assert.equal(body.historical, true);
});

/* ------------------------------------------------------------------ *
 * Live authority always wins
 * ------------------------------------------------------------------ */

test("a genuinely live job is answered from the manager, never shadowed by its own journal entries", async (t) => {
  const worker = new Worker();
  worker.pid = 55123;
  t.mock.method(childProcess, "fork", () => worker);
  syncBuiltinESMExports();
  t.after(() => {
    worker.emit("message", { type: "cancelled" });
    worker.emit("exit", 0, null);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const f = await fixture(t);
  const fs = await import("node:fs/promises");
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  const { base } = await api(t);

  const started = await fetch(`${base}/api/tracks/${f.slug}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preset: "square-1x1" }),
  });
  assert.equal(started.status, 200);
  const jobId = (await started.json()).data.jobId as string;

  const live = (await (await fetch(`${base}/api/renders/${jobId}`)).json()).data;
  assert.equal(live.status, "preparing");
  assert.equal(live.historical, undefined);

  worker.emit("message", { type: "status", status: "rendering" });
  await new Promise((resolve) => setImmediate(resolve));
  const stillLive = (await (await fetch(`${base}/api/renders/${jobId}`)).json()).data;
  assert.equal(stillLive.status, "rendering");
  assert.equal(stillLive.historical, undefined);
});

/* ------------------------------------------------------------------ *
 * Cancel and SSE never touch a historical job
 * ------------------------------------------------------------------ */

test("cancel refuses a historical job with the ordinary not-found route, never a fabricated cancellation", async (t) => {
  const jobId = randomUUID();
  await appendRenderJournalEvent(journalEvent({ jobId, state: "queued" }));
  await appendRenderJournalEvent(journalEvent({ jobId, state: "preparing" }));

  const { base } = await api(t);
  const interrupted = (await (await fetch(`${base}/api/renders/${jobId}`)).json()).data;
  assert.equal(interrupted.status, "interrupted");

  const cancel = await fetch(`${base}/api/renders/${jobId}/cancel`, { method: "POST" });
  assert.equal(cancel.status, 404);
  assert.equal((await cancel.json()).error.code, "RENDER_JOB_NOT_FOUND");

  // Refusing to cancel must not itself fabricate or change the recorded state.
  const after = (await (await fetch(`${base}/api/renders/${jobId}`)).json()).data;
  assert.equal(after.status, "interrupted");
});

test("SSE refuses a historical job outright — no stream, no fake replay", async (t) => {
  const jobId = randomUUID();
  await appendRenderJournalEvent(journalEvent({ jobId, state: "queued" }));
  await appendRenderJournalEvent(journalEvent({ jobId, state: "completed" }));

  const { base } = await api(t);
  const response = await fetch(`${base}/api/renders/${jobId}/events`);
  assert.equal(response.status, 404);
  assert.notEqual(response.headers.get("content-type"), "text/event-stream");
  await response.body?.cancel();
});

/* ------------------------------------------------------------------ *
 * A real restart, across a real OS process boundary
 * ------------------------------------------------------------------ */

test("a real second process, with a different boot id, reports a job the first process never finished as interrupted", async (t) => {
  const journalRoot = process.env.TOSHI_RENDER_JOURNAL_DIR;
  assert.ok(journalRoot);

  const child = fork(new URL("./render-journal-restart-process.mts", import.meta.url), [journalRoot, "probe"], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  const [started] = (await once(child, "message")) as [
    { readonly jobId: string; readonly bootId: string; readonly liveStatus: string },
  ];
  await once(child, "exit");

  // The dying process really did have it live and non-terminal — this is not
  // a job that failed to start.
  assert.equal(started.liveStatus, "rendering");
  assert.notEqual(started.bootId, RENDER_MANAGER_BOOT_ID);

  const { base } = await api(t);
  const recovered = (await (await fetch(`${base}/api/renders/${started.jobId}`)).json()).data;
  assert.equal(recovered.status, "interrupted");
  assert.equal(recovered.historical, true);
  assert.equal(recovered.recoveredAfterRestart, true);

  // And it is exactly as uncancellable and unstreamable as any other
  // historical job — a restart must not make cancel resurrect it.
  const cancel = await fetch(`${base}/api/renders/${started.jobId}/cancel`, { method: "POST" });
  assert.equal(cancel.status, 404);
});
