import type {
  PublicationHistoryView,
  PublishDestinationsView,
  PublishJobsView,
  PublishJobView,
  PublishPlanView,
} from "../../core/domain/api/views.ts";
import { formatCapability } from "../../core/domain/publishing/destinations.ts";
import { queryPublicationHistory, type PublicationHistoryQuery } from "../../core/domain/publishing/publicationHistory.ts";
import {
  destinationMetadataProblems,
  validatePublicationMetadata,
  type PublicationMetadata,
} from "../../core/domain/publishing/publicationMetadata.ts";
import {
  parsePublicationReceipt,
  receiptMismatch,
  PUBLICATION_RECEIPT_SCHEMA_VERSION,
  type PublicationReceipt,
} from "../../core/domain/publishing/publicationReceipt.ts";
import { sameSourceIdentity, type PublicationSourceRef } from "../../core/domain/publishing/publicationSource.ts";
import {
  currentAttempt,
  executionProblem,
  PUBLISH_JOB_SCHEMA_VERSION,
  transitionPublishJob,
  withCurrentAttempt,
  type PublishAttempt,
  type PublishJob,
} from "../../core/domain/publishing/publishJob.ts";
import type { PublishProblem } from "../../core/domain/publishing/publishProblems.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import type {
  PreparedPublication,
  PublishDestination,
  PublishRequest,
  PublishResult,
  RecoveryResult,
} from "../../core/ports/publishDestination.ts";
import type { PublishDestinationRegistry } from "../../core/ports/publishDestinationRegistry.ts";
import { makeCancelSignal, type CancelSignal } from "../../core/ports/renderEngine.ts";
import { withRenderTargetLock } from "../render/renderLock.ts";
import { readPublishingSettings } from "./destinationSettings.ts";
import {
  acquireJobLock,
  appendPublicationReceipt,
  attemptIdentity,
  inspectJobLock,
  listPublishJobFiles,
  newPublishJobId,
  publishingRoot,
  readPublicationReceipts,
  readPublishJobFile,
  receiptIdFor,
  writePublishJobFile,
} from "./publishingStore.ts";
import { pinnedSourceProblems, resolvePublicationSource } from "./resolvePublicationSource.ts";

/**
 * The publishing engine: plans, creates, executes, cancels and reconciles
 * publish jobs against any registered destination.
 *
 * Every host (API, CLI, tests) creates one with the destination registry it
 * wants — services never import an adapter, exactly like rendering.
 *
 * The order of an execution is what makes it safe:
 *
 *  1. Take the job's execution lock (one process per job).
 *  2. Re-validate: destination ready, format accepted, metadata valid, and the
 *     export on disk is *still* the pinned identity and still current.
 *  3. Record a new attempt (fresh attempt id + idempotency key) and save the
 *     job as `publishing` — before the adapter is called, so a crash from here
 *     on is seen as an interruption, never as "nothing happened".
 *  4. Under the export's render target lock (the same one renders and
 *     deliveries take), let the adapter prepare() from the file, then check
 *     the pinned identity again before releasing the lock.
 *  5. publish(). Its result decides the state: published (only with a receipt
 *     that validates against this job, attempt and export), failed (definitely
 *     not published), cancelled, or recovery_required (anything uncertain,
 *     including an adapter that throws).
 *  6. Append the receipt, then save the job. A crash between the two is
 *     reconciled from the receipt log on the next read.
 *
 * Publishing never renders, never re-points a job at another export, and
 * never writes into export, delivery or library records.
 */

export type PublishInput = {
  readonly destinationId: unknown;
  readonly source: PublicationSourceRef;
  readonly metadata: unknown;
  readonly accountId?: string | null;
};

export type PublishingServiceOptions = {
  readonly root?: () => string;
  readonly now?: () => string;
  readonly log?: (message: string) => void;
};

type Active = { readonly cancel: () => void; readonly done: Promise<unknown> };

export const createPublishingService = (
  registry: PublishDestinationRegistry,
  options: PublishingServiceOptions = {},
) => {
  const root = options.root ?? publishingRoot;
  const now = options.now ?? (() => new Date().toISOString());
  const log = options.log ?? (() => {});
  const active = new Map<string, Active>();

  /* ---------------- destinations ---------------- */

  const destinations = (): PublishDestinationsView => ({
    destinations: registry.status(),
    settingsProblem: readPublishingSettings().problem,
  });

  /* ---------------- planning / validation ---------------- */

  const plan = async (input: PublishInput): Promise<PublishPlanView> => {
    const destination = registry.describe(input.destinationId);
    const problems: PublishProblem[] = [];

    if (destination.state === "unavailable")
      problems.push({ reason: "destination_unavailable", message: destination.problem ?? `${destination.displayName} is unavailable.` });
    if (destination.state === "not_configured")
      problems.push({ reason: "destination_not_configured", message: destination.problem ?? `${destination.displayName} is not configured.` });

    const accountId = destination.accountId;
    if (input.accountId !== undefined && input.accountId !== null && input.accountId !== accountId)
      problems.push({
        reason: "destination_not_configured",
        message: `${destination.displayName} is not configured for account "${input.accountId}"${accountId ? ` (configured: "${accountId}")` : ""}.`,
      });

    const capability = destination.capabilities === null ? null : formatCapability(destination.capabilities, input.source.presetId);
    if (destination.capabilities !== null && capability === null)
      problems.push({
        reason: "format_unsupported",
        message: `${destination.displayName} does not accept ${input.source.presetId}. It accepts: ${destination.capabilities.formats.map((f) => f.presetId).join(", ")}.`,
      });

    const resolved = await resolvePublicationSource(input.source);
    problems.push(...resolved.problems);

    const validation = validatePublicationMetadata(input.metadata);
    problems.push(...validation.problems);
    if (validation.metadata !== null && destination.capabilities !== null)
      problems.push(...destinationMetadataProblems(validation.metadata, destination.capabilities.metadata, destination.capabilities, destination.displayName));

    // Adapter-specific checks only once everything generic holds and the destination can load.
    if (problems.length === 0 && validation.metadata !== null && capability !== null && resolved.identity !== null) {
      const adapter = await registry.resolve(destination.id);
      problems.push(
        ...adapter.validate({
          jobId: "pub_000000000000000000000000",
          attemptId: "att_000000000000000000000000",
          idempotencyKey: "0".repeat(64),
          accountId,
          mode: capability.mode,
          metadata: validation.metadata,
          source: resolved.identity,
        }),
      );
    }

    return {
      ok: problems.length === 0,
      destination,
      sourceRef: input.source,
      source: resolved.identity,
      sourceStatus: { freshness: resolved.freshness, staleReasons: resolved.staleReasons, outputLabel: resolved.outputLabel },
      mode: capability?.mode ?? null,
      accountId,
      metadata: validation.metadata,
      problems,
    };
  };

  /* ---------------- reading ---------------- */

  const receiptFor = (job: PublishJob): PublicationReceipt | null => {
    const read = readPublicationReceipts(root());
    return read.receipts.find((receipt) => receipt.jobId === job.jobId) ?? null;
  };

  const view = (job: PublishJob): PublishJobView => ({
    ...job,
    receipt: job.receiptId === null ? null : receiptFor(job),
    executing: active.has(job.jobId),
  });

  const save = async (job: PublishJob) => {
    await writePublishJobFile(job, root());
    return job;
  };

  /**
   * A job left "publishing" by a process that is gone is reconciled here (the
   * caller holds its lock): a receipt for its attempt means it was published
   * — the crash fell between receipt and job save — and otherwise its outcome
   * is unknown, so it fails closed to recovery_required.
   */
  const reconcileLocked = async (job: PublishJob): Promise<PublishJob> => {
    if (job.state !== "publishing" || active.has(job.jobId)) return job;
    const attempt = currentAttempt(job)!;
    const receipt = readPublicationReceipts(root()).receipts.find((entry) => entry.attemptId === attempt.attemptId);
    if (receipt !== undefined && receiptMismatch(job, receipt) === null) {
      return save(
        transitionPublishJob(job, "published", now(), {
          receiptId: receipt.receiptId,
          certainty: "published",
          problems: [],
          attempts: withCurrentAttempt(job, { ...attempt, finishedAt: now(), outcome: "published", publicationId: receipt.publicationId }),
        }, "receipt found after interruption"),
      );
    }
    const problem: PublishProblem = {
      reason: "recovery_required",
      message: "Publishing was interrupted before its outcome was recorded. Reconcile it with the destination before doing anything else.",
    };
    return save(
      transitionPublishJob(job, "recovery_required", now(), {
        certainty: "uncertain",
        problems: [problem],
        attempts: withCurrentAttempt(job, { ...attempt, finishedAt: now(), outcome: "uncertain", problem }),
      }, "interrupted"),
    );
  };

  /** For readers: reconcile only when no live process owns the job. */
  const settleInterrupted = async (job: PublishJob): Promise<PublishJob> => {
    if (job.state !== "publishing" || active.has(job.jobId) || inspectJobLock(job.jobId, root()) === "held") return job;
    let lock;
    try {
      lock = acquireJobLock(job.jobId, root());
    } catch {
      return job;
    }
    try {
      return await reconcileLocked(readPublishJobFile(job.jobId, root()));
    } finally {
      lock.release();
    }
  };

  const getJob = async (jobId: string): Promise<PublishJobView> =>
    view(await settleInterrupted(readPublishJobFile(jobId, root())));

  const listJobs = async (filter: { track?: string; destination?: string } = {}): Promise<PublishJobsView> => {
    const stored = listPublishJobFiles(root());
    const jobs: PublishJobView[] = [];
    for (const job of stored.jobs) {
      if (filter.track !== undefined && job.sourceRef.slug !== filter.track) continue;
      if (filter.destination !== undefined && job.destinationId !== filter.destination) continue;
      jobs.push(view(await settleInterrupted(job)));
    }
    jobs.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { jobs, problems: stored.problems };
  };

  const history = (query: PublicationHistoryQuery = {}): PublicationHistoryView => {
    const read = readPublicationReceipts(root());
    return { status: read.status, receipts: queryPublicationHistory(read.receipts, query), problems: read.problems };
  };

  /* ---------------- creating ---------------- */

  /** Validates (into ready or failed) a job that is pending, failed or ready. Caller holds the lock. */
  const validateJob = async (job: PublishJob): Promise<PublishJob> => {
    let next = transitionPublishJob(job, "validating", now());
    const planned = await plan({ destinationId: job.destinationId, source: job.sourceRef, metadata: job.metadata, accountId: job.accountId });
    const problems: PublishProblem[] = [...planned.problems];
    if (job.source !== null && planned.source !== null && !sameSourceIdentity(planned.source, job.source)) {
      // Once pinned, a job publishes that exact export or nothing.
      problems.push({ reason: "source_changed", message: `${job.source.outputLabel} was re-rendered or replaced after this job was created. Create a new publish job for the new export.` });
    }
    if (problems.length > 0) {
      next = transitionPublishJob(next, "failed", now(), { problems, certainty: "not_published" }, problems[0].reason);
      return next;
    }
    return transitionPublishJob(next, "ready", now(), {
      problems: [],
      source: job.source ?? planned.source,
      mode: planned.mode,
      metadata: planned.metadata as PublicationMetadata,
      accountId: planned.accountId,
    });
  };

  /**
   * Creates a job, validates it and saves it: ready, or failed with every
   * reason. An unknown destination is a request error and creates nothing.
   * Invalid metadata is kept verbatim on the failed job only as far as it is
   * representable; nothing is published from a failed job without revalidation.
   */
  const createJob = async (input: PublishInput): Promise<PublishJobView> => {
    const destination = registry.describe(input.destinationId);
    const at = now();
    const jobId = newPublishJobId();
    const pending: PublishJob = {
      schemaVersion: PUBLISH_JOB_SCHEMA_VERSION,
      jobId,
      createdAt: at,
      updatedAt: at,
      destinationId: destination.id,
      accountId: input.accountId ?? destination.accountId,
      sourceRef: { slug: input.source.slug, presetId: input.source.presetId, renderer: input.source.renderer },
      source: null,
      mode: null,
      metadata: validatePublicationMetadata(input.metadata).metadata ?? safeMetadataSnapshot(input.metadata),
      state: "pending",
      certainty: "not_published",
      problems: [],
      attempts: [],
      receiptId: null,
      history: [{ state: "pending", at }],
    };
    const lock = acquireJobLock(jobId, root());
    try {
      await save(pending);
      // Validated against the request exactly as sent, so every problem is reported.
      const planned = await plan(input);
      const validating = transitionPublishJob(pending, "validating", now());
      const settled = planned.ok
        ? transitionPublishJob(validating, "ready", now(), {
            source: planned.source,
            mode: planned.mode,
            metadata: planned.metadata!,
            accountId: planned.accountId,
          })
        : transitionPublishJob(validating, "failed", now(), { problems: planned.problems, certainty: "not_published" }, planned.problems[0].reason);
      return view(await save(settled));
    } finally {
      lock.release();
    }
  };

  /* ---------------- executing ---------------- */

  const finishAttempt = (job: PublishJob, changes: Partial<PublishAttempt>): PublishAttempt[] => [
    ...withCurrentAttempt(job, { ...currentAttempt(job)!, finishedAt: now(), ...changes }),
  ];

  const recordPublished = async (
    job: PublishJob,
    result: { publicationId: string; url: string | null; publishedAt: string },
    reason: string,
  ): Promise<PublishJob> => {
    const attempt = currentAttempt(job)!;
    const candidate = {
      schemaVersion: PUBLICATION_RECEIPT_SCHEMA_VERSION,
      receiptId: receiptIdFor(attempt.idempotencyKey),
      jobId: job.jobId,
      attemptId: attempt.attemptId,
      idempotencyKey: attempt.idempotencyKey,
      destination: { id: job.destinationId, accountId: job.accountId },
      publicationId: result.publicationId,
      url: result.url,
      mode: job.mode,
      publishedAt: result.publishedAt,
      recordedAt: now(),
      source: job.source,
      metadata: job.metadata,
    };
    const parsed = parsePublicationReceipt(candidate);
    const mismatch = parsed.receipt === null ? parsed.problem : receiptMismatch(job, parsed.receipt);
    if (parsed.receipt === null || mismatch !== null) {
      // The destination says it published, but its answer cannot be recorded
      // as proof. Never "published" without a valid receipt: fail closed.
      const problem: PublishProblem = { reason: "receipt_invalid", message: `The destination reported success, but its receipt is invalid (${mismatch}). Reconcile before retrying.` };
      return transitionPublishJob(job, "recovery_required", now(), {
        certainty: "uncertain",
        problems: [problem],
        attempts: finishAttempt(job, { outcome: "uncertain", publicationId: typeof result.publicationId === "string" ? result.publicationId.slice(0, 128) : null, problem }),
      }, "receipt_invalid");
    }
    let stored: PublicationReceipt;
    try {
      stored = (await appendPublicationReceipt(parsed.receipt, root())).receipt;
    } catch (error) {
      const problem: PublishProblem = { reason: "recovery_required", message: `Published as ${result.publicationId}, but the receipt could not be recorded: ${error instanceof Error ? error.message : String(error)}. Recover this job to record it.` };
      return transitionPublishJob(job, "recovery_required", now(), {
        certainty: "uncertain",
        problems: [problem],
        attempts: finishAttempt(job, { outcome: "uncertain", publicationId: result.publicationId, problem }),
      }, "receipt_not_recorded");
    }
    return transitionPublishJob(job, "published", now(), {
      receiptId: stored.receiptId,
      certainty: "published",
      problems: [],
      attempts: finishAttempt(job, { outcome: "published", publicationId: stored.publicationId }),
    }, reason);
  };

  const applyResult = async (job: PublishJob, result: PublishResult): Promise<PublishJob> => {
    switch (result.outcome) {
      case "published":
        return recordPublished(job, result, "published");
      case "failed": {
        const problem: PublishProblem = { reason: "publish_failed", message: result.message };
        return transitionPublishJob(job, "failed", now(), { certainty: "not_published", problems: [problem], attempts: finishAttempt(job, { outcome: "failed", problem }) }, "publish_failed");
      }
      case "cancelled": {
        const problem: PublishProblem = { reason: "publish_cancelled", message: "Cancelled before anything was published." };
        return transitionPublishJob(job, "cancelled", now(), { certainty: "not_published", problems: [problem], attempts: finishAttempt(job, { outcome: "cancelled", problem }) }, "cancelled");
      }
      case "uncertain": {
        const problem: PublishProblem = { reason: "recovery_required", message: `Outcome unknown: ${result.message} Reconcile with the destination before doing anything else.` };
        return transitionPublishJob(job, "recovery_required", now(), {
          certainty: "uncertain",
          problems: [problem],
          attempts: finishAttempt(job, { outcome: "uncertain", publicationId: result.publicationId, problem }),
        }, "uncertain");
      }
    }
  };

  /** Before the adapter has been asked to publish, failing is definite. */
  const failBeforePublish = (job: PublishJob, problems: readonly PublishProblem[]): PublishJob =>
    transitionPublishJob(job, "failed", now(), {
      certainty: "not_published",
      problems,
      attempts: finishAttempt(job, { outcome: "failed", problem: problems[0] }),
    }, problems[0].reason);

  const run = async (jobId: string, cancelSignal: CancelSignal, isCancelled: () => boolean): Promise<PublishJob> => {
    let job = await reconcileLocked(readPublishJobFile(jobId, root()));
    const problem = executionProblem(job);
    if (problem !== null) throw new TrackError(trackIssue("PUBLISH_JOB_CONFLICT", problem));

    if (job.state === "pending" || job.state === "failed" || job.state === "ready") job = await save(await validateJob(job));
    if (job.state !== "ready") return job;
    if (isCancelled()) return save(transitionPublishJob(job, "cancelled", now(), {}, "cancelled"));

    const adapter: PublishDestination = await registry.resolve(job.destinationId);
    const number = job.attempts.length + 1;
    const { attemptId, idempotencyKey } = attemptIdentity(job.jobId, number);
    const attempt: PublishAttempt = { attemptId, number, idempotencyKey, startedAt: now(), finishedAt: null, outcome: null, publicationId: null, problem: null };
    job = await save(transitionPublishJob(job, "publishing", now(), { attempts: [...job.attempts, attempt] }));

    const context = { cancelSignal, log };
    const source = job.source!;
    let prepared: PreparedPublication | null = null;
    try {
      // Prepare under the export's own lock, so no render or delivery can
      // replace it mid-read; then prove it is still the pinned export.
      let preparedProblems: readonly PublishProblem[] = [];
      try {
        prepared = await withRenderTargetLock(source.slug, source.presetId, async () => {
          const before = await resolvePublicationSource(job.sourceRef);
          preparedProblems = pinnedSourceProblems(before, source);
          if (preparedProblems.length > 0) return null;
          const request: PublishRequest = {
            jobId: job.jobId,
            attemptId,
            idempotencyKey,
            accountId: job.accountId,
            mode: job.mode!,
            metadata: job.metadata,
            source,
            sourceFile: before.file,
            thumbnailFile: job.metadata.thumbnail === null ? null : before.coverFile,
          };
          const result = await adapter.prepare(request, context);
          const after = await resolvePublicationSource(job.sourceRef);
          preparedProblems = pinnedSourceProblems(after, source);
          return result;
        });
      } catch (error) {
        preparedProblems = [{ reason: "publish_failed", message: `Could not prepare the export for publishing: ${error instanceof Error ? error.message : String(error)}` }];
      }
      if (preparedProblems.length > 0 || prepared === null) return await save(failBeforePublish(job, preparedProblems.length > 0 ? preparedProblems : [{ reason: "publish_failed", message: "Preparation produced nothing." }]));
      if (isCancelled()) return await save(await applyResult(job, { outcome: "cancelled" }));

      let result: PublishResult;
      try {
        result = await adapter.publish(prepared, context);
      } catch (error) {
        // An adapter that throws has not told us whether it published.
        result = { outcome: "uncertain", message: `The destination adapter failed unexpectedly: ${error instanceof Error ? error.message : String(error)}.`, publicationId: null };
      }
      return await save(await applyResult(job, result));
    } finally {
      await prepared?.dispose().catch(() => undefined);
    }
  };

  const execute = async (jobId: string): Promise<PublishJobView> => {
    readPublishJobFile(jobId, root()); // 404 before anything else
    if (active.has(jobId)) throw new TrackError(trackIssue("PUBLISH_JOB_CONFLICT", "This job is already publishing."));
    const lock = acquireJobLock(jobId, root());
    const { cancelSignal, cancel } = makeCancelSignal();
    let cancelled = false;
    cancelSignal(() => {
      cancelled = true;
    });
    const done = run(jobId, cancelSignal, () => cancelled);
    active.set(jobId, { cancel, done: done.catch(() => undefined) });
    try {
      return view(await done);
    } finally {
      active.delete(jobId);
      lock.release();
    }
  };

  /* ---------------- cancelling ---------------- */

  const cancel = async (jobId: string): Promise<PublishJobView> => {
    const running = active.get(jobId);
    if (running !== undefined) {
      running.cancel();
      await running.done;
      return getJob(jobId);
    }
    const lock = acquireJobLock(jobId, root());
    try {
      const job = await reconcileLocked(readPublishJobFile(jobId, root()));
      if (!["pending", "validating", "ready", "failed"].includes(job.state))
        throw new TrackError(trackIssue("PUBLISH_JOB_CONFLICT", `A ${job.state.replace("_", " ")} job cannot be cancelled.`));
      return view(await save(transitionPublishJob(job, "cancelled", now(), { problems: [] }, "cancelled")));
    } finally {
      lock.release();
    }
  };

  /* ---------------- reconciling ---------------- */

  /**
   * Settles a recovery_required job from evidence only: a recorded receipt for
   * its attempt, or the adapter's recover() proving published / not published.
   * Anything else leaves it recovery_required.
   */
  const recover = async (jobId: string): Promise<PublishJobView & { readonly recovery: string }> => {
    if (active.has(jobId)) throw new TrackError(trackIssue("PUBLISH_JOB_CONFLICT", "This job is publishing right now."));
    const lock = acquireJobLock(jobId, root());
    try {
      let job = await reconcileLocked(readPublishJobFile(jobId, root()));
      if (job.state !== "recovery_required")
        throw new TrackError(trackIssue("PUBLISH_JOB_CONFLICT", `Only a job whose outcome is uncertain can be recovered; this one is ${job.state}.`));
      const attempt = currentAttempt(job)!;
      const recorded = readPublicationReceipts(root()).receipts.find((entry) => entry.attemptId === attempt.attemptId);
      if (recorded !== undefined && receiptMismatch(job, recorded) === null) {
        job = await save(transitionPublishJob(job, "published", now(), {
          receiptId: recorded.receiptId,
          certainty: "published",
          problems: [],
          attempts: finishAttempt(job, { outcome: "published", publicationId: recorded.publicationId }),
        }, "receipt found"));
        return { ...view(job), recovery: "A receipt for this attempt was already recorded; the job is published." };
      }
      const status = registry.describe(job.destinationId);
      if (status.capabilities?.recover !== true || status.state !== "ready")
        return { ...view(job), recovery: `${status.displayName} cannot reconcile automatically${status.state !== "ready" ? ` (${status.problem})` : ""}. Check the destination by hand.` };
      const adapter = await registry.resolve(job.destinationId);
      let result: RecoveryResult;
      try {
        result = adapter.recover === undefined
          ? { outcome: "unknown", message: "The adapter has no recovery." }
          : await adapter.recover({ jobId: job.jobId, attemptId: attempt.attemptId, idempotencyKey: attempt.idempotencyKey, accountId: job.accountId, publicationId: attempt.publicationId });
      } catch (error) {
        result = { outcome: "unknown", message: error instanceof Error ? error.message : String(error) };
      }
      if (result.outcome === "published") {
        job = await save(await recordPublished(job, result, "recovered"));
        return { ...view(job), recovery: job.state === "published" ? "The destination confirmed the publication; receipt recorded." : "The destination reported a publication, but it could not be recorded." };
      }
      if (result.outcome === "not_published") {
        job = await save(transitionPublishJob(job, "failed", now(), {
          certainty: "not_published",
          problems: [{ reason: "publish_failed", message: "Reconciliation confirmed nothing was published. It can be retried." }],
          attempts: finishAttempt(job, { outcome: "failed" }),
        }, "recovered_not_published"));
        return { ...view(job), recovery: "The destination confirmed nothing was published; the job can be retried." };
      }
      return { ...view(job), recovery: `Still uncertain: ${result.message}` };
    } finally {
      lock.release();
    }
  };

  return { destinations, plan, createJob, getJob, listJobs, execute, cancel, recover, history, isExecuting: (jobId: string) => active.has(jobId) };
};

export type PublishingService = ReturnType<typeof createPublishingService>;

/** Keeps whatever plain text an invalid request carried, so a failed job still shows what was asked. */
const safeMetadataSnapshot = (raw: unknown): PublicationMetadata => {
  const value = (raw !== null && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const text = (input: unknown, max: number) => (typeof input === "string" ? input.slice(0, max) : "");
  return {
    title: text(value.title, 500),
    description: text(value.description, 10_000),
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string").slice(0, 100).map((tag) => tag.slice(0, 100)) : [],
    visibility: value.visibility === "public" || value.visibility === "unlisted" ? value.visibility : "private",
    scheduledAt: null,
    thumbnail: null,
  };
};
