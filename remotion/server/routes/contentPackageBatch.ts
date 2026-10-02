import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ContentPackageBatchApplyView,
  ContentPackageBatchPlanView,
  ContentPackagePlannedActionView,
  ContentPackageBatchJobReferenceView,
} from "../../core/domain/api/views.ts";
import {
  deriveBatchContentPackage,
  type ContentPackagePlannedAction,
} from "../../core/domain/content/contentPackageBatch.ts";
import { readJsonBody, sendOk } from "../http/json.ts";
import {
  buildContentPackagesForSlugs,
  loadContentPackageBatchContext,
  namedBatchSlugs,
  planContentPackageBatch,
  readBatchMode,
  readBatchPlatforms,
  readBatchTracks,
  toRenderTargetsFromPlan,
} from "../services/contentPackagePlan.ts";
import { renderManager } from "../services/renderManager.ts";
import type { RenderBatchEvent } from "../services/renderManager.ts";

/**
 * Batch Content Package Generation: select several tracks, inspect their
 * packages together, plan what building them would queue, and apply that
 * plan through the existing render queue — never a second one.
 *
 * Every handler re-reads current track/queue state; nothing here trusts a
 * plan the caller might be holding from an earlier response. Apply, in
 * particular, re-plans from scratch immediately before queueing (§10 of the
 * brief, "plan revalidation") rather than accepting a plan payload back from
 * the client — which is also why there is no persisted/durable plan object
 * or plan id to go stale in the first place.
 */

const toPlannedActionView = (
  action: ContentPackagePlannedAction,
): ContentPackagePlannedActionView => ({
  slug: action.slug,
  platformId: action.platformId,
  presetId: action.presetId,
  label: action.label,
  kind: action.kind,
  staleReasons: action.staleReasons,
  reason: action.reason,
});

const jobReference = (
  action: ContentPackagePlannedAction,
  jobId: string | null,
  outcome: ContentPackageBatchJobReferenceView["outcome"],
): ContentPackageBatchJobReferenceView => ({
  actionId: `${action.slug}::${action.platformId}::${action.presetId}`,
  slug: action.slug,
  platformId: action.platformId,
  presetId: action.presetId,
  jobId,
  outcome,
});

const adoptedReferences = (actions: readonly ContentPackagePlannedAction[]): readonly ContentPackageBatchJobReferenceView[] => {
  const jobs = renderManager.listJobs();
  return actions.map((action) => {
    const matches = jobs.filter((job) => job.slug === action.slug && job.presetId === action.presetId);
    const active = matches.find((job) => job.status !== "completed" && job.status !== "failed" && job.status !== "cancelled");
    return jobReference(action, (active ?? matches[0])?.id ?? null, "adopted");
  });
};

/** POST /api/content-package/batch/inspect */
export const handleInspectContentPackageBatch = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  const { slugs, duplicates } = namedBatchSlugs(readBatchTracks(body.tracks));
  const mode = readBatchMode(body.mode);
  const platforms = readBatchPlatforms(body.platforms);

  const context = await loadContentPackageBatchContext();
  const results = await buildContentPackagesForSlugs(slugs, context, {
    mode,
    platforms,
  });

  const invalid = results
    .filter((r): r is Extract<typeof r, { found: false }> => !r.found)
    .map((r) => ({ slug: r.slug, reason: r.reason }));
  const packages = results
    .filter((r): r is Extract<typeof r, { found: true }> => r.found)
    .map((r) => r.package);

  const view = deriveBatchContentPackage(packages, { invalid, duplicates });

  sendOk(response, view);
};

/** POST /api/content-package/batch/plan */
export const handlePlanContentPackageBatch = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  const { slugs, duplicates } = namedBatchSlugs(readBatchTracks(body.tracks));
  const mode = readBatchMode(body.mode);
  const platforms = readBatchPlatforms(body.platforms);

  const context = await loadContentPackageBatchContext();
  const results = await buildContentPackagesForSlugs(slugs, context, {
    mode,
    platforms,
  });
  const plan = planContentPackageBatch(results, { duplicates });

  const view: ContentPackageBatchPlanView = {
    mode: plan.mode,
    tracks: plan.tracks,
    renderable: plan.renderable.map(toPlannedActionView),
    adopted: plan.adopted.map(toPlannedActionView),
    ready: plan.ready.map(toPlannedActionView),
    blocked: plan.blocked.map(toPlannedActionView),
    invalid: plan.invalid,
    duplicates: plan.duplicates,
  };

  sendOk(response, view);
};

const MAX_WAIT_MS = 600_000;
const DEFAULT_WAIT_MS = 30_000;

const clampTimeout = (value: unknown): number => {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_WAIT_MS;
  }
  return Math.min(value, MAX_WAIT_MS);
};

/**
 * Waits for a render batch to settle, up to `timeoutMs`. A timeout only means
 * this call stopped waiting — the batch itself keeps running, exactly like
 * confirmed delivery's own "queue now, follow separately" behavior; nothing
 * here cancels anything.
 */
const waitForBatchSettle = (
  batchId: string,
  timeoutMs: number,
): Promise<{ readonly settled: boolean }> => {
  const current = renderManager.getBatch(batchId);
  if (current.status === "finished" || timeoutMs === 0) {
    return Promise.resolve({ settled: current.status === "finished" });
  }

  return new Promise((resolve) => {
    let done = false;
    const finish = (settled: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      resolve({ settled });
    };

    const unsubscribe = renderManager.subscribeBatch(
      batchId,
      (event: RenderBatchEvent) => {
        if (event.batch.status === "finished") finish(true);
      },
    );

    const timer = setTimeout(() => finish(false), timeoutMs);
  });
};

/** POST /api/content-package/batch/apply */
export const handleApplyContentPackageBatch = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  const { slugs, duplicates } = namedBatchSlugs(readBatchTracks(body.tracks));
  const mode = readBatchMode(body.mode);
  const platforms = readBatchPlatforms(body.platforms);
  const wait = body.wait === true;
  const timeoutMs = clampTimeout(body.timeoutMs);

  // Always re-read current state before queueing anything — a plan the
  // caller saw earlier (from /inspect or /plan) is never trusted here.
  const context = await loadContentPackageBatchContext();
  const results = await buildContentPackagesForSlugs(slugs, context, {
    mode,
    platforms,
  });
  const plan = planContentPackageBatch(results, { duplicates });

  const common = {
    mode: plan.mode,
    tracks: plan.tracks,
    adopted: plan.adopted.map(toPlannedActionView),
    alreadyReady: plan.ready.map(toPlannedActionView),
    blocked: plan.blocked.map(toPlannedActionView),
    invalid: plan.invalid,
    duplicates: plan.duplicates,
  };
  const adopted = adoptedReferences(plan.adopted);

  if (plan.renderable.length === 0) {
    const view: ContentPackageBatchApplyView = {
      ...common,
      batchId: null,
      renderBatch: null,
      jobReferences: adopted,
      timedOut: false,
      queued: [],
      lockedElsewhere: [],
      nothingToDo: true,
    };
    sendOk(response, view);
    return;
  }

  const { batch, locked } = renderManager.startBatch(
    toRenderTargetsFromPlan(plan),
  );
  const queuedJobs = new Map(
    batch.jobs.map((job) => [`${job.slug}::${job.presetId}`, job.id]),
  );
  const lockedKeys = new Set(
    locked.map((target) => `${target.slug}::${target.preset}`),
  );

  const queued = plan.renderable.filter((action) =>
    queuedJobs.has(`${action.slug}::${action.presetId}`),
  );
  const lockedElsewhere = plan.renderable.filter((action) =>
    lockedKeys.has(`${action.slug}::${action.presetId}`),
  );
  const jobReferences = [
    ...adopted,
    ...queued.map((action) => jobReference(action,
      queuedJobs.get(`${action.slug}::${action.presetId}`)!, "queued")),
    ...lockedElsewhere.map((action) => jobReference(action, null, "locked_elsewhere")),
  ];

  const { settled } = wait
    ? await waitForBatchSettle(batch.id, timeoutMs)
    : { settled: false };

  const view: ContentPackageBatchApplyView = {
    ...common,
    batchId: batch.id,
    renderBatch: renderManager.getBatch(batch.id),
    jobReferences,
    timedOut: wait && !settled,
    queued: queued.map(toPlannedActionView),
    lockedElsewhere: lockedElsewhere.map(toPlannedActionView),
    nothingToDo: false,
  };

  sendOk(response, view);
};
