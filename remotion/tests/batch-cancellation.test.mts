import assert from "node:assert/strict";
import test from "node:test";
import { deriveContentPackage, type ContentPackageView } from "../src/domain/content/contentPackage.ts";
import { deriveBatchContentPackage } from "../src/domain/content/contentPackageBatch.ts";
import type { RenderJobView } from "../src/domain/api/views.ts";
import { ApiRequestError, cancelRender } from "../ui/api/client.ts";
import {
  cancelBatchTargets,
  cancellationConfirmation,
  preferTerminalSnapshot,
  selectBatchCancellationTargets,
  type BatchCancellationTarget,
} from "../ui/batchCancellation.ts";
import type { BatchSessionJobReference } from "../ui/batchSession.ts";

const pkg = (slug: string, mode: "intent" | "full" = "full"): ContentPackageView =>
  deriveContentPackage({
    slug,
    title: slug,
    validationOk: true,
    metadata: { title: slug, artist: "Toshi", key: "C Minor", bpm: 90 },
    exports: (["youtube-16x9", "vertical-9x16", "square-1x1"] as const).map((presetId) => ({
      presetId,
      status: "missing" as const,
      staleReasons: [],
      intended: presetId === "youtube-16x9",
      delivery: { status: "not_configured" as const, destinationRelativePath: null },
    })),
  }, { mode });

const job = (
  id: string,
  slug: string,
  presetId: RenderJobView["presetId"],
  status: RenderJobView["status"],
): RenderJobView => ({
  id,
  slug,
  presetId,
  batchId: "batch",
  status,
  progress: status === "completed" ? 1 : 0.4,
  framesRendered: 40,
  totalFrames: 100,
  fps: 30,
  elapsedMs: 1000,
  queuedAt: "2026-01-01T00:00:00Z",
  startedAt: "2026-01-01T00:00:01Z",
  finishedAt: status === "completed" || status === "failed" || status === "cancelled"
    ? "2026-01-01T00:00:02Z"
    : null,
  outputPath: status === "completed" ? "/output.mp4" : null,
  outputLabel: status === "completed" ? "out/output.mp4" : null,
  error: status === "failed" ? { code: "RENDER_FAILED", message: "failed" } : null,
});

const reference = (
  slug: string,
  platformId: BatchSessionJobReference["platformId"],
  presetId: BatchSessionJobReference["presetId"],
  jobId: string,
): BatchSessionJobReference => ({
  actionId: `${slug}::${platformId}::${presetId}`,
  slug,
  platformId,
  presetId,
  jobId,
});

const target = (overrides: Partial<BatchCancellationTarget> = {}): BatchCancellationTarget => ({
  actionId: "alpha::youtube::youtube-16x9",
  jobId: "job-alpha",
  slug: "alpha",
  platformId: "youtube",
  platformLabel: "YouTube",
  presetId: "youtube-16x9",
  status: "rendering",
  ...overrides,
});

test("cancellation scope contains only visible active jobs with exact identity", () => {
  const view = deriveBatchContentPackage([pkg("alpha", "intent")]);
  const references = [
    reference("alpha", "youtube", "youtube-16x9", "visible"),
    reference("alpha", "reels", "vertical-9x16", "hidden-mode"),
    reference("bravo", "youtube", "youtube-16x9", "hidden-track"),
    reference("alpha", "instagram-square", "square-1x1", "terminal"),
    reference("alpha", "youtube", "youtube-16x9", "mismatch"),
    reference("alpha", "youtube", "youtube-16x9", "unknown"),
  ];
  const jobs = {
    visible: job("visible", "alpha", "youtube-16x9", "queued"),
    "hidden-mode": job("hidden-mode", "alpha", "vertical-9x16", "rendering"),
    "hidden-track": job("hidden-track", "bravo", "youtube-16x9", "preparing"),
    terminal: job("terminal", "alpha", "square-1x1", "completed"),
    mismatch: job("mismatch", "someone-else", "youtube-16x9", "rendering"),
  };
  assert.deepEqual(
    selectBatchCancellationTargets(view, references, jobs).map((entry) => entry.jobId),
    ["visible"],
  );
});

test("multi-job confirmation names every exact target; one job follows immediate convention", () => {
  assert.equal(cancellationConfirmation([target()]), null);
  assert.equal(
    cancellationConfirmation([
      target(),
      target({
        actionId: "bravo::reels::vertical-9x16",
        jobId: "job-bravo",
        slug: "bravo",
        platformId: "reels",
        platformLabel: "Reels / Shorts",
        presetId: "vertical-9x16",
      }),
    ]),
    "Cancel 2 active renders?\n\nalpha · YouTube\nbravo · Reels / Shorts",
  );
});

test("accepted cancellation stays pending until the server reports terminal", async () => {
  const current = job("job-alpha", "alpha", "youtube-16x9", "rendering");
  const calls: string[] = [];
  const [result] = await cancelBatchTargets([target()], async (id) => {
    calls.push(id);
    return current;
  });
  assert.deepEqual(calls, ["job-alpha"]);
  assert.equal(result!.kind, "accepted");
});

test("queued cancellation can return cancelled immediately", async () => {
  const [result] = await cancelBatchTargets(
    [target({ status: "queued" })],
    async () => job("job-alpha", "alpha", "youtube-16x9", "cancelled"),
  );
  assert.equal(result!.kind, "terminal");
  assert.equal(result!.kind === "terminal" && result.job.status, "cancelled");
});

test("completion winning the cancel race is reconciled as completed", async () => {
  const cannotCancel = new ApiRequestError(409, {
    code: "RENDER_NOT_CANCELLABLE",
    message: "already completed",
  });
  const [result] = await cancelBatchTargets(
    [target()],
    async () => { throw cannotCancel; },
    async () => job("job-alpha", "alpha", "youtube-16x9", "completed"),
  );
  assert.equal(result!.kind, "terminal");
  assert.equal(result!.kind === "terminal" && result.job.status, "completed");
});

test("unknown jobs are not fabricated as cancelled", async () => {
  const missing = new ApiRequestError(404, {
    code: "RENDER_JOB_NOT_FOUND",
    message: "not found",
  });
  const [result] = await cancelBatchTargets(
    [target()],
    async () => { throw missing; },
    async () => { throw missing; },
  );
  assert.equal(result!.kind, "unknown");
});

test("a failed cancel remains retryable and returns the active snapshot", async () => {
  const failure = new ApiRequestError(500, {
    code: "INTERNAL_ERROR",
    message: "cancel endpoint failed",
  });
  const [result] = await cancelBatchTargets(
    [target()],
    async () => { throw failure; },
    async () => job("job-alpha", "alpha", "youtube-16x9", "preparing"),
  );
  assert.equal(result!.kind, "failed");
  assert.equal(result!.kind === "failed" && result.job?.status, "preparing");
  assert.equal(result!.kind === "failed" && result.error.message, "cancel endpoint failed");
});

test("partial cancellation outcomes settle independently", async () => {
  const targets = [
    target(),
    target({ jobId: "job-bravo", slug: "bravo", actionId: "bravo::youtube::youtube-16x9" }),
    target({ jobId: "job-charlie", slug: "charlie", actionId: "charlie::youtube::youtube-16x9" }),
  ];
  const failure = new ApiRequestError(500, { code: "INTERNAL_ERROR", message: "boom" });
  const results = await cancelBatchTargets(
    targets,
    async (id) => {
      if (id === "job-alpha") return job(id, "alpha", "youtube-16x9", "cancelled");
      if (id === "job-bravo") throw failure;
      return job(id, "charlie", "youtube-16x9", "rendering");
    },
    async (id) => job(id, "bravo", "youtube-16x9", "failed"),
  );
  assert.deepEqual(results.map((result) => result.kind), ["terminal", "terminal", "accepted"]);
  assert.deepEqual(results.map((result) => result.kind === "terminal" ? result.job.status : null), ["cancelled", "failed", null]);
});

test("an observed terminal snapshot cannot be overwritten by a stale cancel response", () => {
  const completed = job("job-alpha", "alpha", "youtube-16x9", "completed");
  const stale = job("job-alpha", "alpha", "youtube-16x9", "rendering");
  assert.equal(preferTerminalSnapshot(completed, stale), completed);
  assert.equal(preferTerminalSnapshot(stale, completed), completed);
});

test("the exact-job cancellation POST survives an immediate browser navigation", async (t) => {
  const originalFetch = globalThis.fetch;
  let seen: RequestInit | undefined;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    seen = init;
    return new Response(JSON.stringify({
      ok: true,
      data: job("job-alpha", "alpha", "youtube-16x9", "cancelled"),
    }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  await cancelRender("job-alpha");
  assert.equal(seen?.method, "POST");
  assert.equal(seen?.keepalive, true);
});
