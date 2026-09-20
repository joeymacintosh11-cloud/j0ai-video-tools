export type TrackErrorCode =
  | "TRACK_NOT_FOUND"
  | "TRACK_ALREADY_EXISTS"
  | "INVALID_TRACK_NAME"
  | "INVALID_SLUG"
  | "INVALID_REQUEST"
  | "INVALID_PRESET"
  | "INVALID_PLATFORM"
  | "COVER_MISSING"
  | "AUDIO_MISSING"
  | "METADATA_MISSING"
  | "METADATA_INVALID"
  | "METADATA_WRITE_FAILED"
  | "METADATA_CONFLICT"
  | "UPLOAD_INVALID"
  | "UPLOAD_TOO_LARGE"
  | "UPLOAD_FAILED"
  | "REVEAL_FAILED"
  | "ANALYSIS_STALE"
  | "FFMPEG_NOT_FOUND"
  | "ANALYSIS_GENERATION_FAILED"
  | "RENDER_FAILED"
  | "RENDER_JOB_NOT_FOUND"
  | "RENDER_BATCH_NOT_FOUND"
  | "RENDER_NOT_CANCELLABLE"
  | "RENDER_ALREADY_ACTIVE"
  | "RENDER_TARGET_LOCKED";

export type TrackIssue = {
  readonly code: TrackErrorCode;
  /** Human-readable, safe to show verbatim in a CLI or UI. */
  readonly message: string;
  /** Project-relative path the issue refers to, when applicable. */
  readonly path?: string;
};

export const trackIssue = (
  code: TrackErrorCode,
  message: string,
  path?: string,
): TrackIssue => ({ code, message, path });

/**
 * An expected, actionable failure — always safe to show to the user as-is.
 * Consumers distinguish these from unexpected errors: a CLI prints the
 * message and exits 1, a server maps it to a 4xx.
 */
export class TrackError extends Error {
  readonly code: TrackErrorCode;
  readonly path?: string;

  constructor(issue: TrackIssue) {
    super(issue.message);
    this.name = "TrackError";
    this.code = issue.code;
    this.path = issue.path;
  }

  get issue(): TrackIssue {
    return trackIssue(this.code, this.message, this.path);
  }
}
