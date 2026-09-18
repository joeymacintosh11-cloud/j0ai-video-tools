import type { TrackErrorCode, TrackIssue } from "../tracks/errors.ts";
import type {
  TrackMetadata,
  TrackMetadataDraft,
  TrackStatus,
  ValidationResult,
} from "../tracks/types.ts";
import type { RenderPresetId } from "../video/renderPresets.ts";

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
  /**
   * Per-format export state, in preset order — the one place this lives, so the
   * track list and the detail panel read exactly the same thing.
   */
  readonly exports: readonly RenderOutputView[];
  /**
   * The formats this track declares it ships in, or null when it declares
   * none. Null is not "no formats": an undeclared track is treated as intending
   * every format, which is what each export's `intended` already reflects. The
   * distinction is kept so the UI can say "not declared yet" rather than
   * showing an intent the user never chose.
   */
  readonly exportPresets: readonly RenderPresetId[] | null;
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
  /** Opaque revision for conditional metadata saves; null when absent. */
  readonly metadataRevision: string | null;
  readonly validation: ValidationResult;
  readonly assets: {
    readonly cover: string;
    readonly beat: string;
    readonly analysis: string;
    readonly metadata: string;
  };
  readonly render: {
    /** True when any format has been rendered for this track. */
    readonly present: boolean;
    /** A render made before presets existed still sits at out/<slug>.mp4. */
    readonly legacyPresent: boolean;
    /** The default format's output; kept for callers predating presets. */
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
  /**
   * The formats this track is meant to ship in. Omitted leaves whatever the
   * file already declares — including nothing, so saving an unrelated field
   * never invents an intent the user did not choose.
   */
  readonly exportPresets?: readonly RenderPresetId[];
};

/** POST /api/tracks request body. */
export type CreateTrackBody = {
  readonly title: string;
  /** Intended formats for the new track. Omitted uses the default. */
  readonly exportPresets?: readonly RenderPresetId[];
};

/**
 * One export format's state for a track.
 *
 * `present` is the filesystem answer and the one that decides whether an export
 * needs making. `queued` and `active` describe work in flight, which lives in
 * the server's memory and is forgotten on restart — so they inform the UI but
 * never stand in for a finished file.
 */
export type RenderOutputView = {
  readonly presetId: RenderPresetId;
  /** Short preset label, e.g. "Reels 9:16". */
  readonly label: string;
  readonly outputLabel: string;
  readonly outputPath: string | null;
  readonly present: boolean;
  readonly bytes: number | null;
  readonly modifiedAt: string | null;
  /** The file exists but is empty, so it does not count as an export. */
  readonly empty: boolean;
  /** A job for this track and format is waiting for the render slot. */
  readonly queued: boolean;
  /** A job for this track and format is preparing or rendering now. */
  readonly active: boolean;
  /**
   * This track is meant to ship in this format. Intent is separate from every
   * other flag here: a format can be intended and missing, or rendered without
   * being intended, and the two say different things.
   */
  readonly intended: boolean;
};

/** The two files a client may upload into a track. */
export type TrackAssetKind = "cover" | "beat";

/**
 * PUT /api/tracks/:slug/cover and /beat
 *
 * The request body is the raw file; there is no multipart form and no filename
 * is sent, because the destination is fixed by the endpoint rather than chosen
 * by the client.
 */
export type UploadAssetView = {
  readonly slug: string;
  readonly kind: TrackAssetKind;
  /** public/-relative label for the file that was written. */
  readonly path: string;
  readonly bytes: number;
  readonly replaced: boolean;
  /** The track as it stands after the upload. */
  readonly track: TrackDetailView;
};

/**
 * POST /api/tracks/:slug/reveal
 *
 * Shows the rendered video in Finder. The client sends only the slug; the path
 * is resolved server-side, so no filesystem path is ever accepted from it.
 */
export type RevealOutputView = {
  readonly slug: string;
  readonly outputPath: string;
  readonly outputLabel: string;
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
  /** Which export format this job renders. */
  readonly presetId: RenderPresetId;
  /** The batch this job belongs to, or null for a single render. */
  readonly batchId: string | null;
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

/** One track/format pair to render. */
export type RenderTarget = {
  readonly slug: string;
  readonly preset: RenderPresetId;
};

/** POST /api/render-batches request body. */
export type CreateRenderBatchBody = {
  readonly targets: readonly RenderTarget[];
};

/**
 * GET /api/render-batches/:batchId
 *
 * Counts come straight from the member jobs. `progress` is the mean of their
 * real progress, with a completed job counting as 1 — a job that failed or was
 * cancelled keeps whatever progress it had reached, so a batch containing one
 * can finish below 100%. Nothing here is synthesized to look tidy.
 */
export type RenderBatchView = {
  readonly id: string;
  readonly createdAt: string;
  readonly totalJobs: number;
  readonly queued: number;
  readonly preparing: number;
  readonly rendering: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  /** preparing + rendering. */
  readonly active: number;
  /** completed + failed + cancelled. */
  readonly settled: number;
  readonly progress: number;
  /** "running" until every job has settled. */
  readonly status: "running" | "finished";
  /** Member jobs in the order they were queued. */
  readonly jobs: readonly RenderJobView[];
};

/* ------------------------------------------------------------------ *
 * Export what is missing
 * ------------------------------------------------------------------ */

/** One track/format pair in an export plan. */
export type PlannedTargetView = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  /** Short preset label, e.g. "Reels 9:16". */
  readonly label: string;
  readonly outputLabel: string;
};

/** A track that cannot be exported, and why. */
export type InvalidTrackView = {
  readonly slug: string;
  readonly code: string;
  readonly reason: string;
};

/**
 * POST /api/export-missing request body.
 *
 * Exactly one of `tracks` and `catalogue` picks what to cover, and `presets`
 * picks the formats. Requiring `catalogue` to be stated outright — rather than
 * reading an absent `tracks` as "everything" — means a malformed request can
 * never queue the whole catalogue by accident.
 */
export type ExportMissingBody = {
  /** Tracks to cover. Mutually exclusive with `catalogue`. */
  readonly tracks?: readonly string[];
  /** Cover every track under public/tracks/. */
  readonly catalogue?: boolean;
  /**
   * Formats to cover, overriding each track's declared intent for this
   * request. Omitted means use what each track's metadata declares — which for
   * a track that declares nothing is every format, as it always was.
   */
  readonly presets?: readonly RenderPresetId[] | null;
  /** Report the plan without queueing anything. */
  readonly dryRun?: boolean;
};

/**
 * POST /api/export-missing
 *
 * `missing` is what needs rendering, and is filled in whether or not anything
 * was queued — that is what makes a dry run useful as a preview. `queued` is
 * what was actually enqueued, so it is empty on a dry run and equal to
 * `missing` otherwise. The three `skipped*` lists say why the rest needed no
 * work: the file already exists, a render is already waiting, or one is running
 * now.
 *
 * `intendedTargets` is every export these tracks are meant to ship, whatever
 * its state — so it is the sum of `missing` and the three `skipped*` lists, and
 * it is what "21 intended exports" in a summary counts.
 */
export type ExportMissingView = {
  readonly batchId: string | null;
  readonly dryRun: boolean;
  /** True when the plan covered the whole catalogue rather than named tracks. */
  readonly catalogue: boolean;
  /** How many tracks were considered, renderable or not. */
  readonly tracks: number;
  /** Every export these tracks intend, in whatever state. */
  readonly intendedTargets: readonly PlannedTargetView[];
  /** Exports that do not exist yet and are not already on their way. */
  readonly missing: readonly PlannedTargetView[];
  /** Exports actually enqueued by this call; empty on a dry run. */
  readonly queued: readonly PlannedTargetView[];
  readonly skippedExisting: readonly PlannedTargetView[];
  readonly skippedQueued: readonly PlannedTargetView[];
  readonly skippedActive: readonly PlannedTargetView[];
  readonly invalid: readonly InvalidTrackView[];
  /** True when every requested export already exists or is already on its way. */
  readonly nothingToDo: boolean;
};

/** POST /api/render-batches */
export type CreateRenderBatchView = {
  readonly batchId: string;
  readonly batch: RenderBatchView;
  /** Targets already queued or running, which were not queued again. */
  readonly skipped: readonly RenderTarget[];
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
