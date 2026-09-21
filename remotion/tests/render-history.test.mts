import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { fork } from "node:child_process";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { handleRequest } from "../server/app.ts";
import { RENDER_MANAGER_BOOT_ID } from "../server/services/renderJournal.ts";
import {
  RENDER_JOURNAL_SCHEMA_VERSION,
  type RenderJournalEvent,
} from "../src/domain/render/renderJournal.ts";
import { appendRenderJournalEvent } from "../services/render/renderJournalLog.ts";
import { fixture } from "./fixtures.mts";
import { Worker } from "./managerHarness.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

await isolateRenderJournalForThisFile();

/**
 * GET /api/render-history (server/routes/renderHistory.ts) — the
 * operator-facing surface over the durable render journal added in this
 * milestone. See tests/render-journal-recovery.test.mts for the equivalent
 * per-job-id surface (GET /api/renders/:id) this one complements; the same
 * real-HTTP-server-over-the-real-singleton technique is reused here for the
 * same reason (those routes are not written to accept an injected manager).
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

const journalEvent = (
  slug: string,
  overrides: Partial<RenderJournalEvent>,
): RenderJournalEvent => ({
  schemaVersion: RENDER_JOURNAL_SCHEMA_VERSION,
  eventId: randomUUID(),
  jobId: randomUUID(),
  batchId: null,
  slug,
  presetId: "youtube-16x9",
  state: "queued",
  recordedAt: new Date().toISOString(),
  bootId: RENDER_MANAGER_BOOT_ID,
  error: null,
  ...overrides,
});

const history = async (base: string, track: string, limit?: number) => {
  const params = new URLSearchParams({ track, ...(limit === undefined ? {} : { limit: String(limit) }) });
  const response = await fetch(`${base}/api/render-history?${params.toString()}`);
  return { status: response.status, body: (await response.json()) as { readonly ok: boolean; readonly data?: unknown; readonly error?: { readonly code: string; readonly message: string } } };
};

/* ------------------------------------------------------------------ *
 * Basic per-state answers (1-5)
 * ------------------------------------------------------------------ */

test("a track with no render history reports an empty list, not an error", async (t) => {
  const { base } = await api(t);
  const { status, body } = await history(base, `probe-${randomUUID()}`);
  assert.equal(status, 200);
  const data = body.data as { readonly jobs: readonly unknown[]; readonly status: string };
  assert.deepEqual(data.jobs, []);
  assert.equal(data.status, "missing");
});

test("a single completed job appears as one historical entry", async (t) => {
  const slug = `probe-${randomUUID()}`;
  const jobId = randomUUID();
  await appendRenderJournalEvent(journalEvent(slug, { jobId, state: "queued" }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId, state: "preparing" }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId, state: "completed" }));

  const { base } = await api(t);
  const { status, body } = await history(base, slug);
  assert.equal(status, 200);
  const data = body.data as { readonly jobs: readonly { readonly status: string; readonly historical: true }[] };
  assert.equal(data.jobs.length, 1);
  assert.equal(data.jobs[0].status, "completed");
  assert.equal(data.jobs[0].historical, true);
});

test("a single failed job appears with its error", async (t) => {
  const slug = `probe-${randomUUID()}`;
  const jobId = randomUUID();
  await appendRenderJournalEvent(journalEvent(slug, { jobId, state: "queued" }));
  await appendRenderJournalEvent(
    journalEvent(slug, { jobId, state: "failed", error: { code: "RENDER_FAILED", message: "boom" } }),
  );

  const { base } = await api(t);
  const { body } = await history(base, slug);
  const data = body.data as { readonly jobs: readonly { readonly status: string; readonly error: { readonly code: string; readonly message: string } | null }[] };
  assert.equal(data.jobs[0].status, "failed");
  assert.equal(data.jobs[0].error?.code, "RENDER_FAILED");
  assert.equal(data.jobs[0].error?.message, "boom");
});

test("a single cancelled job appears as a terminal historical entry", async (t) => {
  const slug = `probe-${randomUUID()}`;
  const jobId = randomUUID();
  await appendRenderJournalEvent(journalEvent(slug, { jobId, state: "queued" }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId, state: "cancelled" }));

  const { base } = await api(t);
  const { body } = await history(base, slug);
  const data = body.data as { readonly jobs: readonly { readonly status: string }[] };
  assert.equal(data.jobs[0].status, "cancelled");
});

test("a prior-boot non-terminal job appears as interrupted, with recoveredAfterRestart true", async (t) => {
  const slug = `probe-${randomUUID()}`;
  const jobId = randomUUID();
  await appendRenderJournalEvent(journalEvent(slug, { jobId, state: "queued", bootId: "some-earlier-boot" }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId, state: "preparing", bootId: "some-earlier-boot" }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId, state: "rendering", bootId: "some-earlier-boot" }));

  const { base } = await api(t);
  const { body } = await history(base, slug);
  const data = body.data as { readonly jobs: readonly { readonly status: string; readonly recoveredAfterRestart: boolean }[] };
  assert.equal(data.jobs[0].status, "interrupted");
  assert.equal(data.jobs[0].recoveredAfterRestart, true);
});

/* ------------------------------------------------------------------ *
 * Grouping, filtering and ordering (6-10)
 * ------------------------------------------------------------------ */

test("several jobs for one track all appear, newest first, one entry per job — not per lifecycle event", async (t) => {
  const slug = `probe-${randomUUID()}`;
  const jobIds = [randomUUID(), randomUUID(), randomUUID()];

  for (const [i, jobId] of jobIds.entries()) {
    await appendRenderJournalEvent(
      journalEvent(slug, { jobId, state: "queued", recordedAt: new Date(Date.UTC(2026, 8, 21, i)).toISOString() }),
    );
    await appendRenderJournalEvent(
      journalEvent(slug, { jobId, state: "preparing", recordedAt: new Date(Date.UTC(2026, 8, 21, i, 1)).toISOString() }),
    );
    await appendRenderJournalEvent(
      journalEvent(slug, { jobId, state: "completed", recordedAt: new Date(Date.UTC(2026, 8, 21, i, 2)).toISOString() }),
    );
  }

  const { base } = await api(t);
  const { body } = await history(base, slug, 10);
  const data = body.data as { readonly jobs: readonly { readonly jobId: string }[] };
  // Six lifecycle events per job (9 total events for 3 jobs) must reduce to
  // exactly 3 entries — one per job — newest job first.
  assert.equal(data.jobs.length, 3);
  assert.deepEqual(data.jobs.map((job) => job.jobId), [...jobIds].reverse());
});

test("several presets for one track each appear as their own entry", async (t) => {
  const slug = `probe-${randomUUID()}`;
  const landscapeId = randomUUID();
  const verticalId = randomUUID();
  await appendRenderJournalEvent(journalEvent(slug, { jobId: landscapeId, state: "queued", presetId: "youtube-16x9" }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId: landscapeId, state: "preparing", presetId: "youtube-16x9" }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId: landscapeId, state: "completed", presetId: "youtube-16x9" }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId: verticalId, state: "queued", presetId: "vertical-9x16" }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId: verticalId, state: "failed", presetId: "vertical-9x16" }));

  const { base } = await api(t);
  const { body } = await history(base, slug, 10);
  const data = body.data as { readonly jobs: readonly { readonly presetId: string }[] };
  assert.equal(data.jobs.length, 2);
  assert.deepEqual(new Set(data.jobs.map((job) => job.presetId)), new Set(["youtube-16x9", "vertical-9x16"]));
});

test("jobs belonging to other tracks are excluded", async (t) => {
  const slug = `probe-${randomUUID()}`;
  const otherSlug = `other-${randomUUID()}`;
  await appendRenderJournalEvent(journalEvent(slug, { state: "queued" }));
  await appendRenderJournalEvent(journalEvent(otherSlug, { state: "queued" }));
  await appendRenderJournalEvent(journalEvent(otherSlug, { state: "preparing" }));
  await appendRenderJournalEvent(journalEvent(otherSlug, { state: "completed" }));

  const { base } = await api(t);
  const { body } = await history(base, slug, 10);
  const data = body.data as { readonly jobs: readonly { readonly slug: string }[] };
  assert.equal(data.jobs.length, 1);
  assert.equal(data.jobs[0].slug, slug);
});

/* ------------------------------------------------------------------ *
 * Input validation (11, 15)
 * ------------------------------------------------------------------ */

test("an invalid slug is rejected rather than used to filter the journal", async (t) => {
  const { base } = await api(t);
  const { status, body } = await history(base, "../not a slug");
  assert.equal(status, 400);
  assert.equal(body.error?.code, "INVALID_SLUG");
});

test("limit is bounded: out-of-range values are rejected, not silently clamped or ignored", async (t) => {
  const { base } = await api(t);
  const slug = `probe-${randomUUID()}`;

  const tooLow = await history(base, slug, 0);
  assert.equal(tooLow.status, 400);
  assert.equal(tooLow.body.error?.code, "INVALID_REQUEST");

  const tooHigh = await history(base, slug, 11);
  assert.equal(tooHigh.status, 400);
  assert.equal(tooHigh.body.error?.code, "INVALID_REQUEST");

  const atMax = await history(base, slug, 10);
  assert.equal(atMax.status, 200);
});

test("the default limit is small (3), for a request that names none", async (t) => {
  const slug = `probe-${randomUUID()}`;
  for (let i = 0; i < 5; i++) {
    const jobId = randomUUID();
    await appendRenderJournalEvent(
      journalEvent(slug, { jobId, state: "queued", recordedAt: new Date(Date.UTC(2026, 8, 21, i)).toISOString() }),
    );
    await appendRenderJournalEvent(
      journalEvent(slug, { jobId, state: "preparing", recordedAt: new Date(Date.UTC(2026, 8, 21, i)).toISOString() }),
    );
    await appendRenderJournalEvent(
      journalEvent(slug, { jobId, state: "completed", recordedAt: new Date(Date.UTC(2026, 8, 21, i, 1)).toISOString() }),
    );
  }

  const { base } = await api(t);
  const { body } = await history(base, slug);
  const data = body.data as { readonly jobs: readonly unknown[]; readonly limit: number };
  assert.equal(data.limit, 3);
  assert.equal(data.jobs.length, 3);
});

/* ------------------------------------------------------------------ *
 * Damaged / unusual journal content (12, 13, 20, 21)
 *
 * Tested at the pure domain level, not through this shared HTTP server:
 * see "recentRenderJobsForSlug survives..." in tests/render-journal.test.mts.
 * Deliberately not here — this file's journal root is shared by every test
 * in it (isolateRenderJournalForThisFile is file-scoped, per
 * renderJournalTestIsolation.mts's own comment), and Node's test runner
 * runs this file's top-level tests concurrently; a raw, lock-bypassing
 * write of a truncated or malformed line here would race the *locked*
 * appends other concurrently-running tests are legitimately making to the
 * very same file, corrupting them too. parseRenderJournal/
 * reconstructRenderJournal/recentRenderJobsForSlug are pure functions that
 * need no real file at all, so the corruption tests construct their input
 * as a plain string instead — safe, deterministic, and exactly what
 * render-journal.test.mts already does for parseRenderJournal itself.
 * ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ *
 * Privacy / no raw internals leaked (16)
 * ------------------------------------------------------------------ */

test("a job's response never carries a filesystem path, boot id or any field beyond the documented shape", async (t) => {
  const slug = `probe-${randomUUID()}`;
  const jobId = randomUUID();
  await appendRenderJournalEvent(journalEvent(slug, { jobId, state: "queued" }));
  await appendRenderJournalEvent(
    journalEvent(slug, {
      jobId,
      state: "failed",
      error: { code: "RENDER_FAILED", message: "The render worker exited unexpectedly." },
    }),
  );

  const { base } = await api(t);
  const { body } = await history(base, slug);
  const data = body.data as { readonly jobs: readonly Record<string, unknown>[] };
  const job = data.jobs[0];

  assert.deepEqual(
    new Set(Object.keys(job)),
    new Set(["jobId", "slug", "presetId", "status", "recordedAt", "historical", "recoveredAfterRestart", "error"]),
  );
  const serialized = JSON.stringify(job);
  assert.ok(!serialized.includes("out/"), "response must not leak a filesystem path");
  assert.ok(!serialized.includes(RENDER_MANAGER_BOOT_ID), "response must not leak the raw boot id");
});

/* ------------------------------------------------------------------ *
 * Live authority still wins for the list surface too
 * ------------------------------------------------------------------ */

test("a job currently live in the render manager is excluded from history, never shown as interrupted", async (t) => {
  const worker = new Worker();
  worker.pid = 55321;
  const t2 = t as TestContext;
  t2.mock.method(childProcess, "fork", () => worker);
  syncBuiltinESMExports();
  t2.after(() => {
    worker.emit("message", { type: "cancelled" });
    worker.emit("exit", 0, null);
    t2.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const f = await fixture(t);
  const fs = await import("node:fs/promises");
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  const { base } = await api(t);

  // An older, already-settled historical job for the same track, so the list
  // is not simply empty once the live one is excluded.
  const oldJobId = randomUUID();
  await appendRenderJournalEvent(journalEvent(f.slug, { jobId: oldJobId, state: "queued" }));
  await appendRenderJournalEvent(journalEvent(f.slug, { jobId: oldJobId, state: "preparing" }));
  await appendRenderJournalEvent(journalEvent(f.slug, { jobId: oldJobId, state: "completed" }));

  const started = await fetch(`${base}/api/tracks/${f.slug}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preset: "square-1x1" }),
  });
  assert.equal(started.status, 200);
  worker.emit("message", { type: "status", status: "rendering" });
  await new Promise((resolve) => setImmediate(resolve));

  const { body } = await history(base, f.slug, 10);
  const data = body.data as { readonly jobs: readonly { readonly jobId: string; readonly status: string }[] };
  assert.equal(data.jobs.length, 1);
  assert.equal(data.jobs[0].jobId, oldJobId);
  assert.equal(data.jobs[0].status, "completed");
});

/* ------------------------------------------------------------------ *
 * Real E2E — a genuine restart, and a live job alongside a historical one
 * ------------------------------------------------------------------ */

test("a real second process, with a different boot id, reports an unfinished job as interrupted through the history endpoint", async (t) => {
  const journalRoot = process.env.TOSHI_RENDER_JOURNAL_DIR;
  assert.ok(journalRoot);
  const slug = `probe-${randomUUID()}`;

  const child = fork(new URL("./render-journal-restart-process.mts", import.meta.url), [journalRoot, slug], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });

  const [started] = (await once(child, "message")) as [
    { readonly jobId: string; readonly bootId: string; readonly liveStatus: string },
  ];
  await once(child, "exit");
  assert.equal(started.liveStatus, "rendering");
  assert.notEqual(started.bootId, RENDER_MANAGER_BOOT_ID);

  const { base } = await api(t);
  const { status, body } = await history(base, slug, 10);
  assert.equal(status, 200);
  const data = body.data as { readonly jobs: readonly { readonly jobId: string; readonly status: string; readonly recoveredAfterRestart: boolean }[] };
  assert.equal(data.jobs.length, 1);
  assert.equal(data.jobs[0].jobId, started.jobId);
  assert.equal(data.jobs[0].status, "interrupted");
  assert.equal(data.jobs[0].recoveredAfterRestart, true);
});

test("an interrupted job from a dead process and a new live job for the same track are never conflated", async (t) => {
  const journalRoot = process.env.TOSHI_RENDER_JOURNAL_DIR;
  assert.ok(journalRoot);
  const slug = `probe-${randomUUID()}`;

  // Phase 1: a real second process starts a render, reaches "rendering", and
  // exits without ever finishing — a real crash/restart.
  const child = fork(new URL("./render-journal-restart-process.mts", import.meta.url), [journalRoot, slug], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const [dead] = (await once(child, "message")) as [{ readonly jobId: string }];
  await once(child, "exit");

  // Phase 2: this process — a genuinely different boot id, playing "the
  // restarted server" — starts a fresh render for the very same track,
  // through the real renderManager singleton directly (mirroring how
  // render-journal-restart-process.mts itself starts a render: startRender
  // only validates the slug's shape, never that a track fixture exists on
  // disk, so none is needed here either).
  const worker = new Worker();
  worker.pid = 55987;
  const t2 = t as TestContext;
  t2.mock.method(childProcess, "fork", () => worker);
  syncBuiltinESMExports();
  t2.after(() => {
    worker.emit("message", { type: "cancelled" });
    worker.emit("exit", 0, null);
    t2.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const { base } = await api(t);
  const { renderManager } = await import("../server/services/renderManager.ts");
  const liveJob = renderManager.startRender(slug, "vertical-9x16");
  const liveJobId = liveJob.id;
  worker.emit("message", { type: "status", status: "rendering" });
  await new Promise((resolve) => setImmediate(resolve));

  // The live job must be answered live, unambiguously, from /api/renders/:id.
  const live = (await (await fetch(`${base}/api/renders/${liveJobId}`)).json()).data;
  assert.equal(live.status, "rendering");
  assert.equal(live.historical, undefined);

  // The history list must show only the dead job as interrupted — never the
  // live one, and never conflating the two exact job identities.
  const { body } = await history(base, slug, 10);
  const data = body.data as { readonly jobs: readonly { readonly jobId: string; readonly status: string }[] };
  assert.equal(data.jobs.length, 1);
  assert.equal(data.jobs[0].jobId, dead.jobId);
  assert.equal(data.jobs[0].status, "interrupted");
  assert.notEqual(data.jobs[0].jobId, liveJobId);
});
