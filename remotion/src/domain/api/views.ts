import type { TrackErrorCode, TrackIssue } from "../tracks/errors.ts";
import type {
  TrackMetadata,
  TrackMetadataDraft,
  TrackStatus,
  ValidationResult,
} from "../tracks/types.ts";

/**
 * The local API's wire format, declared once and shared by both ends.
 *
 * These are pure type declarations with no runtime code, so they live in
 * src/domain/ alongside the rest of the browser-safe layer: the server
 * implements them and the UI consumes them, and neither restates the other's
 * shape. All Node-specific implementation (serializers, path resolution, the
 * render manager, the worker IPC protocol) stays under server/.
 *
 * Every field here is something the server actually sends today — this file
 * describes the existing API, it does not propose a new one.
 */

/* ------------------------------------------------------------------ *
 * Envelope
 * ------------------------------------------------------------------ */

/**
 * Error codes a client can receive: the shared domain codes, plus the two the
 * HTTP layer adds for an unrouted path and an unexpected failure.
 */
export type ApiErrorCode = TrackErrorCode | "NOT_FOUND" | "INTERNAL_ERROR";

export type ApiError = {
  readonly code: ApiErrorCode;
  readonly message: string;
  readonly path?: string;
  /** Technical detail for debugging; never the only thing reported. */
  readonly details?: string;
};

export type ApiSuccess<TData> = {
  readonly ok: true;
  readonly data: TData;
};

export type ApiFailure = {
  readonly ok: false;
  readonly error: ApiError;
};

export type ApiResponse<TData> = ApiSuccess<TData> | ApiFailure;

/* ------------------------------------------------------------------ *
 * Tracks
 * ------------------------------------------------------------------ */

/** GET /api/health */
export type HealthView = {
  readonly ok: boolean;
  readonly service: string;
};

/** One row in GET /api/tracks. */
export type TrackSummaryView = {
  readonly slug: string;
  readonly title: string | null;
  readonly status: TrackStatus;
  /** metadata.json exists on disk, whether or not its contents are complete. */
  readonly metadataPresent: boolean;
  /** metadata.json parsed and every required field is valid — i.e. renderable. */
  readonly metadataValid: boolean;
  readonly coverPresent: boolean;
  readonly audioPresent: boolean;
  readonly analysisPresent: boolean;
  readonly analysisUpToDate: boolean;
  readonly renderPresent: boolean;
};

/** GET /api/tracks/:slug, and the response to create/metadata updates. */
export type TrackDetailView = TrackSummaryView & {
  /** Set only when the track is fully valid and renderable. */
  readonly metadata: TrackMetadata | null;
  /**
   * What metadata.json currently holds, coerced rather than validated — the
   * shape an editor prefills from, so a draft or not-yet-valid track can still
   * be edited. Null when the file is absent or is not a JSON object.
   */
  readonly metadataDraft: TrackMetadataDraft | null;
  readonly validation: ValidationResult;
  readonly assets: {
    readonly cover: string;
    readonly beat: string;
    readonly analysis: string;
    readonly metadata: string;
  };
  readonly render: {
    readonly present: boolean;
    readonly outputLabel: string;
    /** Absolute path, so a UI can reveal it in Finder. */
    readonly outputPath: string | null;
  };
  readonly previewEndpoint: string;
};

/**
 * PATCH /api/tracks/:slug/metadata request body.
 *
 * Every field a caller is allowed to change. The slug is never one of them —
 * editing `title` does not rename the track folder.
 */
export type TrackMetadataPatch = {
  readonly title?: string;
  readonly artist?: string;
  readonly key?: string;
  readonly bpm?: number | null;
  readonly subtitle?: string;
};

/** POST /api/tracks request body. */
export type CreateTrackBody = {
  readonly title: string;
};

/** POST /api/tracks/:slug/validate */
export type ValidateTrackView = {
  readonly slug: string;
  readonly status: TrackStatus;
  readonly validation: ValidationResult;
  readonly assets: TrackSummaryView;
};

/** POST /api/tracks/:slug/prepare */
export type PrepareTrackView = {
  readonly slug: string;
  readonly status: TrackStatus;
  readonly metadata: TrackMetadata;
  readonly validation: ValidationResult;
  readonly analysis: {
    /** Path to analysis.wav relative to public/, e.g. "tracks/x/analysis.wav". */
    readonly path: string;
    readonly generated: boolean;
    readonly alreadyUpToDate: boolean;
  };
  readonly elapsedMs: number;
};

export type CompositionConfigView = {
  readonly id: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
};

/**
 * GET /api/tracks/:slug/preview
 *
 * Parameterized over the composition's props rather than importing them:
 * src/domain/ is the innermost layer and must not depend on the composition it
 * describes. Both the server and the UI supply BeatVisualizerProps here, so the
 * contract stays checked at both ends without this file reaching outward.
 */
export type TrackPreviewView<TInputProps = unknown> = {
  readonly slug: string;
  readonly composition: CompositionConfigView;
  readonly durationInFrames: number;
  readonly durationInSeconds: number;
  /** Ready to hand straight to <Player inputProps={...} />. */
  readonly inputProps: TInputProps;
  readonly analysisAvailable: boolean;
  readonly studioUrlHint: string;
};

/* ------------------------------------------------------------------ *
 * Render jobs
 * ------------------------------------------------------------------ */

export type RenderJobStatus =
  | "queued"
  | "preparing"
  | "rendering"
  | "completed"
  | "failed"
  | "cancelled";

export type RenderJobLogEntry = {
  readonly at: string;
  readonly level: "info" | "error";
  readonly message: string;
};

export type RenderJobError = {
  readonly code: TrackErrorCode | "INTERNAL_ERROR";
  readonly message: string;
  readonly path?: string;
  /** Technical detail for debugging; never the only thing reported. */
  readonly details?: string;
};

/** Serialized job state, as returned by the API. */
export type RenderJobView = {
  readonly id: string;
  readonly slug: string;
  readonly status: RenderJobStatus;
  readonly progress: number;
  readonly framesRendered: number | null;
  readonly totalFrames: number | null;
  readonly fps: number | null;
  readonly elapsedMs: number;
  readonly startedAt: string | null;
  readonly queuedAt: string;
  readonly finishedAt: string | null;
  readonly outputPath: string | null;
  readonly outputLabel: string | null;
  readonly error: RenderJobError | null;
};

/** POST /api/tracks/:slug/render */
export type StartRenderView = {
  readonly jobId: string;
  readonly status: RenderJobStatus;
  readonly job: RenderJobView;
};

/** GET /api/renders/:jobId/logs */
export type RenderLogsView = {
  readonly id: string;
  readonly slug: string;
  readonly status: RenderJobStatus;
  readonly logs: readonly RenderJobLogEntry[];
};

/**
 * Event names on GET /api/renders/:jobId/events.
 *
 * `log` carries a RenderJobLogEntry; every other event carries a
 * RenderJobView.
 */
export type RenderEventName =
  | "status"
  | "progress"
  | "log"
  | "completed"
  | "failed"
  | "cancelled";

/** A validation error or warning, re-exported so clients need one import. */
export type { TrackIssue };
