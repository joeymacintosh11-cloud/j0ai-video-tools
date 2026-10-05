/**
 * Why a publication cannot go ahead, or did not complete.
 *
 * Lowercase reasons, like StaleReason and DeliveryReason: these describe
 * states of the world carried on plans, jobs and receipts, not thrown request
 * errors. Malformed requests (an unknown destination id, a missing job) are
 * TrackErrors with PUBLISH_* codes instead.
 */
export type PublishProblemReason =
  | "destination_unknown"
  | "destination_unavailable"
  | "destination_not_configured"
  | "format_unsupported"
  | "track_invalid"
  | "export_missing"
  | "export_stale"
  /** The export changed after the job pinned its identity. */
  | "source_changed"
  | "publication_metadata_invalid"
  | "publish_failed"
  | "publish_cancelled"
  | "recovery_required"
  | "receipt_invalid"
  /** The job already has a publication; a second one is refused. */
  | "already_published";

export const PUBLISH_PROBLEM_LABELS: Record<PublishProblemReason, string> = {
  destination_unknown: "Unknown destination",
  destination_unavailable: "Destination unavailable",
  destination_not_configured: "Destination not configured",
  format_unsupported: "Format not supported by this destination",
  track_invalid: "Track is not valid",
  export_missing: "Export missing",
  export_stale: "Export stale — re-render first",
  source_changed: "Export changed since this job was created",
  publication_metadata_invalid: "Publication metadata invalid",
  publish_failed: "Publish failed",
  publish_cancelled: "Publish cancelled",
  recovery_required: "Outcome uncertain — reconciliation required",
  receipt_invalid: "Publication receipt invalid",
  already_published: "Already published",
};

export type PublishProblem = {
  readonly reason: PublishProblemReason;
  readonly message: string;
  /** The metadata field concerned, for publication_metadata_invalid. */
  readonly field?: string;
};
