import type { DestinationId, PublicationMode } from "./destinations.ts";
import type { PublicationMetadata } from "./publicationMetadata.ts";
import type { PublicationSourceIdentity, PublicationSourceRef } from "./publicationSource.ts";
import type { PublishProblem } from "./publishProblems.ts";

/**
 * A publish job: one request to publish one pinned export to one destination.
 *
 * Lifecycle (every transition is listed in PUBLISH_TRANSITIONS; anything else
 * is refused):
 *
 *   pending ──> validating ──> ready ──> publishing ──> published
 *                  │  ^          │            │
 *                  v  └──────────┘            ├──> failed ─────────┐ (retry: new attempt)
 *                failed                       ├──> cancelled       │
 *                  │                          └──> recovery_required
 *                  └────────> validating <─────────────────────────┘
 *
 *   recovery_required ──> published | failed   (only from reconciliation evidence)
 *   any non-terminal, not publishing ──> cancelled
 *
 * - `published` is reachable only with a receipt that has been validated
 *   against this job, its current attempt and its pinned source
 *   (assertPublishable below). There is no other way to set it.
 * - `failed` always means *definitely not published*: the adapter was never
 *   called, or it reported a failure it knows happened before anything took
 *   effect. Only such failures may be retried.
 * - `recovery_required` means the outcome is uncertain — the adapter was
 *   interrupted, threw unexpectedly, or reported success with a receipt that
 *   did not validate. It fails closed: no retry, no receipt, until a
 *   reconciliation (PublishDestination.recover) proves one outcome.
 *
 * Pure and browser-safe. Files, locks and ids live in services/publishing/.
 */

export const PUBLISH_JOB_SCHEMA_VERSION = 1;

export type PublishJobState =
  | "pending"
  | "validating"
  | "ready"
  | "publishing"
  | "published"
  | "failed"
  | "cancelled"
  | "recovery_required";

export const PUBLISH_JOB_STATES: readonly PublishJobState[] = [
  "pending",
  "validating",
  "ready",
  "publishing",
  "published",
  "failed",
  "cancelled",
  "recovery_required",
];

export const PUBLISH_TRANSITIONS: Record<PublishJobState, readonly PublishJobState[]> = {
  pending: ["validating", "cancelled"],
  validating: ["ready", "failed", "cancelled"],
  ready: ["validating", "publishing", "cancelled"],
  publishing: ["published", "failed", "cancelled", "recovery_required"],
  failed: ["validating", "cancelled"],
  recovery_required: ["published", "failed"],
  published: [],
  cancelled: [],
};

export const isTerminalPublishState = (state: PublishJobState): boolean =>
  state === "published" || state === "cancelled";

export const canTransitionPublishJob = (from: PublishJobState, to: PublishJobState): boolean =>
  PUBLISH_TRANSITIONS[from].includes(to);

/**
 * What is known about whether something reached the destination.
 * - not_published: definitely nothing took effect
 * - published:     a validated receipt exists
 * - uncertain:     unknown; requires reconciliation
 */
export type PublicationCertainty = "not_published" | "published" | "uncertain";

export type PublishAttemptOutcome = "published" | "failed" | "cancelled" | "uncertain";

/**
 * One try at publishing. Each attempt has its own id and idempotency key, so a
 * retry after a definite failure is a *new* attempt, while repeating the same
 * attempt (a crashed process resuming, a double click) reuses the same key and
 * can never yield a second receipt.
 */
export type PublishAttempt = {
  readonly attemptId: string;
  /** 1-based. */
  readonly number: number;
  /** Handed to the adapter; derived from the job id and attempt number. */
  readonly idempotencyKey: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly outcome: PublishAttemptOutcome | null;
  /** Set when the adapter reached the destination far enough to name the publication. */
  readonly publicationId: string | null;
  readonly problem: PublishProblem | null;
};

export type PublishJob = {
  readonly schemaVersion: number;
  readonly jobId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly destinationId: DestinationId;
  /** The account/profile identifier it publishes as, when the destination has accounts. */
  readonly accountId: string | null;
  /** What was asked for. */
  readonly sourceRef: PublicationSourceRef;
  /** What was pinned at validation; null until the export was found current. */
  readonly source: PublicationSourceIdentity | null;
  readonly mode: PublicationMode | null;
  readonly metadata: PublicationMetadata;
  readonly state: PublishJobState;
  readonly certainty: PublicationCertainty;
  /** Problems from the most recent validation (empty when it passed). */
  readonly problems: readonly PublishProblem[];
  readonly attempts: readonly PublishAttempt[];
  readonly receiptId: string | null;
  /** State history, newest last; transitions only, never content. */
  readonly history: readonly { readonly state: PublishJobState; readonly at: string; readonly reason?: string }[];
};

export class PublishTransitionError extends Error {
  readonly from: PublishJobState;
  readonly to: PublishJobState;

  constructor(from: PublishJobState, to: PublishJobState) {
    super(`A publish job cannot go from ${from} to ${to}.`);
    this.name = "PublishTransitionError";
    this.from = from;
    this.to = to;
  }
}

/** The one way a job changes state. Throws on a transition the lifecycle does not allow. */
export const transitionPublishJob = (
  job: PublishJob,
  to: PublishJobState,
  at: string,
  changes: Partial<Omit<PublishJob, "state" | "history" | "updatedAt" | "jobId" | "schemaVersion">> = {},
  reason?: string,
): PublishJob => {
  if (!canTransitionPublishJob(job.state, to)) throw new PublishTransitionError(job.state, to);
  if (to === "published" && (changes.receiptId ?? job.receiptId) === null)
    throw new Error("A publish job cannot become published without a validated receipt.");
  return {
    ...job,
    ...changes,
    state: to,
    updatedAt: at,
    history: [...job.history, { state: to, at, ...(reason === undefined ? {} : { reason }) }],
  };
};

export const currentAttempt = (job: PublishJob): PublishAttempt | null =>
  job.attempts.length === 0 ? null : job.attempts[job.attempts.length - 1];

/** Replaces the current (last) attempt. */
export const withCurrentAttempt = (job: PublishJob, attempt: PublishAttempt): readonly PublishAttempt[] =>
  job.attempts.length === 0 ? [attempt] : [...job.attempts.slice(0, -1), attempt];

/**
 * Whether a new execution may start. A failed job may be retried only when
 * its failure was definite; an uncertain one must be reconciled first.
 */
export const executionProblem = (job: PublishJob): string | null => {
  switch (job.state) {
    case "ready":
    case "pending":
    case "validating":
      return null;
    case "failed":
      if (job.certainty !== "not_published") return "This job's outcome is uncertain; reconcile it before retrying.";
      // Its metadata never validated, so there is nothing trustworthy to retry with.
      return job.source === null && job.problems.some((problem) => problem.reason === "publication_metadata_invalid")
        ? "This job's publication metadata is invalid; create a new job with corrected metadata."
        : null;
    case "publishing":
      return "This job is already publishing.";
    case "published":
      return "This job is already published; create a new job to publish again.";
    case "cancelled":
      return "This job was cancelled; create a new job to publish.";
    case "recovery_required":
      return "This job's outcome is uncertain. Reconcile it (recover) before doing anything else; it is never retried blindly.";
  }
};

/** Text hashed (in services/) into an attempt's idempotency key. Stable across processes. */
export const attemptIdentityText = (jobId: string, attemptNumber: number): string =>
  `toshi-publish-attempt\u0000${jobId}\u0000${attemptNumber}`;

export const PUBLISH_JOB_ID_PATTERN = /^pub_[a-f0-9]{24}$/;
export const PUBLISH_ATTEMPT_ID_PATTERN = /^att_[a-f0-9]{24}$/;
export const IDEMPOTENCY_KEY_PATTERN = /^[a-f0-9]{64}$/;
