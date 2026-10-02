import { randomUUID } from "node:crypto";
import {
  appendRenderJournalEvent,
  readRenderJournal,
} from "../render/renderJournalLog.ts";
import {
  classifyRecoveredJob,
  reconstructRenderJournal,
  recentRenderJobsForSlug,
  RENDER_HISTORY_DEFAULT_LIMIT,
  RENDER_JOURNAL_SCHEMA_VERSION,
  type RecoveredRenderJob,
  type RenderJournalLifecycleState,
  type RenderJournalStatus,
} from "../../core/domain/render/renderJournal.ts";

/**
 * Wires the pure journal model (core/domain/render/renderJournal.ts) and its
 * file I/O (services/render/renderJournalLog.ts) into the render manager.
 *
 * This module owns the one thing neither of those can: the running process's
 * identity. `BOOT_ID` is created once, the moment this module is first
 * imported, and is what turns "last recorded state was rendering" into
 * "interrupted" after a restart — a *different* process's `BOOT_ID` reading
 * the same journal will never match it.
 */
export const RENDER_MANAGER_BOOT_ID = randomUUID();

export type RenderJournalRecordInput = {
  readonly jobId: string;
  readonly batchId: string | null;
  readonly slug: string;
  readonly presetId: string;
  readonly state: RenderJournalLifecycleState;
  readonly error: { readonly code: string; readonly message: string } | null;
};

/**
 * Every write currently in flight, so tests can wait for the journal to go
 * quiet without guessing a timeout (see `waitForRenderJournalIdle` below).
 * Production code never reads this — `renderManager` fires a journal write
 * and moves on regardless of how long it takes.
 */
const inFlight = new Set<Promise<unknown>>();

/**
 * Records one lifecycle transition, durably, without ever blocking the
 * caller or turning a write failure into a render failure.
 *
 * `renderManager` calls this and discards the promise — the render itself
 * must proceed identically whether or not its history could be written (see
 * services/render/renderJournalLog.ts's own comment on this, and §40/§41 of
 * the milestone this implements). The promise is still returned, rather than
 * the function being fire-and-forget internally, so a test that needs to
 * know an append has actually landed on disk before asserting can await it
 * directly, and every call also registers itself in `inFlight` so a test
 * that only has the *side effect* (a job moved to some status) rather than
 * this promise can still wait deterministically via
 * `waitForRenderJournalIdle`.
 */
export const recordRenderJournalEvent = (
  input: RenderJournalRecordInput,
): Promise<void> => {
  const write = appendRenderJournalEvent({
    schemaVersion: RENDER_JOURNAL_SCHEMA_VERSION,
    eventId: randomUUID(),
    jobId: input.jobId,
    batchId: input.batchId,
    slug: input.slug,
    presetId: input.presetId,
    state: input.state,
    recordedAt: new Date().toISOString(),
    bootId: RENDER_MANAGER_BOOT_ID,
    error: input.error,
  }).then((result) => {
    if (!result.appended) {
      // Degraded durability, not a failed render: reported and moved past.
      console.error(
        `[render-journal] could not record "${input.state}" for job ${input.jobId}: ${result.problem}`,
      );
    }
  });

  // Registered synchronously, before this function returns, so a caller that
  // triggers a journal write and then immediately awaits
  // waitForRenderJournalIdle() cannot observe an empty set and return early
  // while the write it just caused is still genuinely pending.
  inFlight.add(write);
  write.finally(() => inFlight.delete(write)).catch(() => undefined);

  return write;
};

/**
 * Resolves once every journal write issued so far has settled.
 *
 * Test-only: waits on a *snapshot* of `inFlight` taken at call time, so it
 * cannot hang waiting on a write triggered after it was called. Exists
 * because renderManager deliberately never awaits its own journal writes
 * (see `recordRenderJournalEvent` above) — a test that needs the file on disk
 * to reflect a status change it just caused (rather than merely the in-memory
 * job) awaits this instead of guessing a delay.
 */
export const waitForRenderJournalIdle = async (): Promise<void> => {
  await Promise.allSettled([...inFlight]);
};

/**
 * Answers "what did the journal last know about this job?" for a job the
 * live render manager does not have (or no longer has).
 *
 * Reconstructs from the whole file on every call rather than caching —
 * deliberately: appends are low-frequency (lifecycle transitions only, never
 * progress frames) and the journal is kept small by retention, so a full
 * parse is cheap (see tests/render-journal.test.mts's benchmark), and a cache
 * would need its own invalidation for no real benefit. Returns `null` for a
 * job the journal has never heard of, which the caller treats exactly like
 * today's plain 404.
 */
export const getHistoricalRenderJob = (jobId: string): RecoveredRenderJob | null => {
  const read = readRenderJournal();
  const { jobs } = reconstructRenderJournal(read.events);
  const record = jobs.get(jobId);

  return record ? classifyRecoveredJob(record, RENDER_MANAGER_BOOT_ID) : null;
};

export type RecentRenderHistoryResult = {
  readonly status: RenderJournalStatus;
  readonly jobs: readonly RecoveredRenderJob[];
};

/**
 * The most recent renders of one track, newest first, grouped by job — the
 * server-side half of the operator-facing render-history surface
 * (`GET /api/render-history`, `server/routes/renderHistory.ts`).
 *
 * Reads and reconstructs the whole journal on every call, exactly like
 * `getHistoricalRenderJob` above and for the same reason: appends are
 * low-frequency and the journal is kept small by retention, so this is cheap
 * (see tests/render-journal.test.mts's benchmark, which this milestone's own
 * benchmark test extends to this function). `status` is returned alongside
 * the jobs — a track's history can still be reported even when the journal is
 * damaged elsewhere, exactly like the delivery log's own `status`/`events`
 * split (core/domain/delivery/deliveryHistory.ts).
 */
export const getRecentRenderHistory = (
  slug: string,
  limit: number = RENDER_HISTORY_DEFAULT_LIMIT,
  excludeJobIds: ReadonlySet<string> = new Set(),
): RecentRenderHistoryResult => {
  const read = readRenderJournal();
  const reconstruction = reconstructRenderJournal(read.events);

  return {
    status: read.status,
    jobs: recentRenderJobsForSlug(
      reconstruction,
      slug,
      RENDER_MANAGER_BOOT_ID,
      limit,
      excludeJobIds,
    ),
  };
};
