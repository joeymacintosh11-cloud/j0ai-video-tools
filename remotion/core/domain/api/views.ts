import type {
  ExportFreshness,
  ExportMode,
  StaleReason,
} from "../video/exportFreshness.ts";
import type {
  DeliveryReason,
  DeliveryStatus,
} from "../delivery/deliveryPaths.ts";
import type {
  DeliveryHistoryOrder,
  DeliveryHistorySummary,
  DeliveryLogEvent,
  DeliveryLogProblem,
  DeliveryLogStatus,
} from "../delivery/deliveryHistory.ts";
import type { RenderJournalStatus } from "../render/renderJournal.ts";
import type {
  ContentLibraryEntry,
  ContentLibraryProblem,
  ContentLibraryStatus,
  ContentLibrarySummary,
  LibraryFormatSummary,
} from "../library/contentLibrary.ts";
import type {
  DestinationFinding,
  DestinationHealthCounts,
  DestinationHealthStatus,
} from "../delivery/destinationHealth.ts";
import type {
  RemediationAction,
  RemediationActionResult,
  RemediationPlanSummary,
} from "../delivery/destinationFixPlan.ts";
import type { ReleaseBundleFreshness } from "../delivery/releaseBundle.ts";
import type { ContentPackageMode } from "../content/contentPackage.ts";
import type {
  BatchInvalidTrackEntry,
  ContentPackageActionKind,
} from "../content/contentPackageBatch.ts";
import type { PlatformId } from "../content/platformProfiles.ts";
import type {
  MetadataTemplatesResetPatch,
  PartialMetadataTemplates,
} from "../content/metadataTemplates.ts";
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
 * core/domain/ alongside the rest of the browser-safe layer: the server
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
  /**
   * The folder this track delivers into, or null when it has not chosen one and
   * falls back to its slug. A portable folder name, never a machine path.
   */
  readonly deliveryFolder: string | null;
  /**
   * Whether this track's release bundle still describes what it shipped.
   * Reported here rather than from a separate endpoint, since it is derived
   * from state this view already gathers.
   */
  readonly releaseBundle: ReleaseBundleStatusView;
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
  /**
   * Folder this track delivers into, inside the configured destination. Empty
   * string clears it, which falls back to the slug.
   */
  readonly deliveryFolder?: string;
  /**
   * Per-track content package metadata template overrides. Omitted leaves
   * whatever is already declared; `null` clears every override (every field
   * goes back to inheriting the global template or the built-in default); an
   * object replaces the whole set — never deep-merged with what is on disk.
   */
  readonly contentMetadataOverrides?: PartialMetadataTemplates | null;
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
 * `present` reports a nonempty file; `freshness` decides whether it still
 * matches its inputs. `status` overlays validation and queue state. `queued` and `active` describe work in flight, which lives in
 * the server's memory and is forgotten on restart — so they inform the UI but
 * never stand in for a finished file.
 */
export type RenderOutputView = {
  readonly freshness: ExportFreshness;
  readonly staleReasons: readonly StaleReason[];
  readonly status: ExportFreshness | "queued" | "rendering";
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
  /**
   * Where this export stands at the configured destination. Separate from
   * `freshness` throughout: a current export may be undelivered, and a
   * delivered copy may be outdated. "not_configured" means delivery is off.
   */
  readonly delivery: DeliveryTargetStateView;
};

/** One export's delivery state, derived from disk on every read. */
export type DeliveryTargetStateView = {
  readonly status: DeliveryStatus;
  readonly reason: DeliveryReason | null;
  /** Absolute destination, or null when delivery is off. */
  readonly destinationPath: string | null;
  /** Path inside the destination root, e.g. "Ghetto Geek/x-square-1x1.mp4". */
  readonly destinationRelativePath: string | null;
  readonly deliveredAt: string | null;
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
 * core/domain/ is the innermost layer and must not depend on the composition it
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

/**
 * `interrupted` is never assigned by the render manager itself — nothing
 * observes a job "becoming" interrupted, so nothing ever emits it as a live
 * status transition. It exists purely as a recovered/historical answer: the
 * render journal's honest description of a job that was queued/preparing/
 * rendering the last time any process recorded it, and whose owning process
 * is not the one answering now (see core/domain/render/renderJournal.ts and
 * server/services/renderJournal.ts). A client sees it only from
 * `GET /api/renders/:id` when `historical` is also true.
 */
export type RenderJobStatus =
  | "queued"
  | "preparing"
  | "rendering"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

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
  /**
   * Set only when this view was answered from the durable render journal
   * rather than from a job the render manager currently holds live in
   * memory. Absent (never `false`) on every ordinary live response, so
   * existing callers that never look at it see no change at all.
   */
  readonly historical?: boolean;
  /**
   * Only meaningful alongside `historical: true`. `true` means the job's
   * last recorded activity belonged to a different process than the one
   * answering — a genuine restart. `false` means the same process answering
   * now is the one that ran it, and it has simply aged out of the render
   * manager's bounded in-memory history after settling.
   */
  readonly recoveredAfterRestart?: boolean;
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
  readonly staleReasons?: readonly StaleReason[];
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
  readonly mode?: ExportMode;
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
 * POST /api/export-missing.
 * `missing`, `stale` and `current` report disk state outside work in flight.
 * `selected` is the work requested by this mode; `queued` is what was actually
 * enqueued and is empty on dry runs. `skippedExisting` remains the compatibility
 * presence list (current or stale), not a count of verified current exports.
 * `intendedTargets` includes every renderable track/format pair considered.
 */
export type ExportMissingView = {
  readonly mode: ExportMode;
  readonly stale: readonly PlannedTargetView[];
  readonly current: readonly PlannedTargetView[];
  readonly selected: readonly PlannedTargetView[];
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
  /**
   * Targets another process holds a render lock on, left out of the batch.
   * Reported separately from the queue skips because the answer is different:
   * nothing here is being rendered by this server.
   */
  readonly lockedElsewhere: readonly PlannedTargetView[];
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
  /** Targets another process is rendering, which were not queued either. */
  readonly locked: readonly RenderTarget[];
};

/* ------------------------------------------------------------------ *
 * Local export delivery
 * ------------------------------------------------------------------ */

/** GET /api/delivery/settings, and the response to a settings update. */
export type DeliverySettingsView = {
  /** Absolute destination root, or null when delivery is off. */
  readonly root: string | null;
  /** True when the configured root exists and is reachable right now. */
  readonly available: boolean;
  /** Why the configured root is unusable, when it is not. */
  readonly problem: string | null;
  /** Copy automatically after a successful render. Opt-in. */
  readonly autoDeliver: boolean;
  /** Rewrite a track's release bundle after a successful delivery. Opt-in. */
  readonly autoUpdateReleaseBundle: boolean;
  /** Where the machine-local setting is stored, for the UI to name. */
  readonly settingsPath: string;
};

/**
 * PUT /api/delivery/settings request body.
 *
 * `root` is an absolute path typed or pasted by the user, validated
 * server-side. It is the only place a destination path is ever accepted; every
 * delivery request names tracks and formats, never paths.
 */
export type DeliverySettingsBody = {
  readonly root?: string | null;
  readonly autoDeliver?: boolean;
  readonly autoUpdateReleaseBundle?: boolean;
};

/** One target's result from a delivery attempt. */
export type DeliveryOutcomeView = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly label: string;
  readonly status: DeliveryStatus;
  readonly reason: DeliveryReason | null;
  readonly destinationPath: string | null;
  readonly destinationRelativePath: string | null;
  readonly bytes: number | null;
  readonly message: string | null;
  /** The delivery log event this copy was recorded as, when it was. */
  readonly historyEventId: string | null;
  /**
   * Why the copy was not recorded in the destination's delivery log. Never a
   * delivery failure — the file is published and its receipt committed.
   */
  readonly historyProblem: string | null;
};

/** One target in a delivery plan. */
export type DeliveryTargetView = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly label: string;
  readonly outputLabel: string;
  /** The canonical export's freshness, which is separate from the copy's. */
  readonly freshness: ExportFreshness;
  readonly status: DeliveryStatus;
  readonly reason: DeliveryReason | null;
  readonly destinationRelativePath: string | null;
};

/**
 * POST /api/delivery/deliver request body.
 *
 * Mirrors /api/export-missing: name tracks, or ask for the catalogue outright.
 * No destination is accepted here — the server resolves it from stored
 * settings, so a request can never point a copy somewhere of its choosing.
 */
export type DeliverBody = {
  readonly tracks?: readonly string[];
  readonly catalogue?: boolean;
  readonly presets?: readonly RenderPresetId[] | null;
  readonly dryRun?: boolean;
};

/** POST /api/delivery/deliver */
export type DeliverView = {
  readonly dryRun: boolean;
  readonly catalogue: boolean;
  readonly tracks: number;
  readonly root: string | null;
  readonly rootProblem: string | null;
  /** Every intended export considered, whatever its state. */
  readonly considered: readonly DeliveryTargetView[];
  /** Current exports that need copying. */
  readonly deliverable: readonly DeliveryTargetView[];
  readonly alreadyDelivered: readonly DeliveryTargetView[];
  /** Missing or stale exports, which must be re-rendered before delivery. */
  readonly notCurrent: readonly DeliveryTargetView[];
  readonly invalid: readonly InvalidTrackView[];
  /** Results of the copies this call performed; empty on a dry run. */
  readonly delivered: readonly DeliveryOutcomeView[];
  /**
   * Release bundles rewritten afterwards. Empty unless auto-update is switched
   * on. A bundle that could not be written never changes the fact that the
   * copies landed, so it is reported here rather than as a delivery failure.
   */
  readonly releaseBundles: readonly ReleaseBundleResultView[];
  /** True when every considered export is already at the destination. */
  readonly nothingToDo: boolean;
};

/**
 * POST /api/delivery/reveal
 *
 * Shows the destination in Finder. Takes an optional slug and preset, never a
 * path; the server resolves what to reveal from stored settings.
 */
export type DeliveryRevealBody = {
  readonly slug?: string;
  readonly preset?: RenderPresetId;
};

export type DeliveryRevealView = {
  readonly revealedPath: string;
};

/* ------------------------------------------------------------------ *
 * Release bundles
 * ------------------------------------------------------------------ */

/**
 * Whether a track's release bundle still describes what it has shipped.
 *
 * Folded into the track views rather than given its own endpoint, so the UI
 * gets it with data it already fetches. Counts are of the track's *intended*
 * formats, so they say how complete the release is.
 */
export type ReleaseBundleStatusView = {
  readonly freshness: ReleaseBundleFreshness;
  /** Portable location, e.g. "Ghetto Geek/release.json". Null when off. */
  readonly relativePath: string | null;
  /** When the bundle on disk was written, if there is one. */
  readonly generatedAt: string | null;
  readonly delivered: number;
  readonly outdated: number;
  readonly missing: number;
  /** Why no bundle can be described for this track at all. */
  readonly problem: string | null;
};

/** One track in a release bundle plan. */
export type ReleaseBundleTrackView = ReleaseBundleStatusView & {
  readonly slug: string;
};

/** What one generation attempt did. */
export type ReleaseBundleResultView = ReleaseBundleTrackView & {
  readonly generated: boolean;
};

/**
 * POST /api/release-bundles request body.
 *
 * Mirrors the delivery endpoints: name tracks, or ask for the catalogue
 * outright. No path is accepted — bundles are written into each track's own
 * destination folder, which the server resolves from stored settings.
 */
export type ReleaseBundleBody = {
  readonly tracks?: readonly string[];
  readonly catalogue?: boolean;
  /** Report what would be written without writing anything. */
  readonly dryRun?: boolean;
  /** Rewrite bundles that are already current. */
  readonly force?: boolean;
};

/** POST /api/release-bundles */
export type ReleaseBundlesView = {
  readonly dryRun: boolean;
  readonly catalogue: boolean;
  readonly tracks: number;
  readonly root: string | null;
  readonly rootProblem: string | null;
  readonly current: readonly ReleaseBundleTrackView[];
  readonly outdated: readonly ReleaseBundleTrackView[];
  readonly missing: readonly ReleaseBundleTrackView[];
  /** Tracks with no destination, or that cannot be described. */
  readonly unavailable: readonly ReleaseBundleTrackView[];
  /** Results of what this call wrote; empty on a dry run. */
  readonly generated: readonly ReleaseBundleResultView[];
  /** True when every bundle in scope is already current. */
  readonly nothingToDo: boolean;
};

/* ------------------------------------------------------------------ *
 * Content packages
 * ------------------------------------------------------------------ */

/**
 * GET /api/content-package
 *
 * A platform-facing view over state the app already computes — export
 * coverage/freshness, queue state and delivery state — never a second source
 * of truth. See core/domain/content/contentPackage.ts for the derivation and
 * the reasoning behind it.
 */
export type ContentPackageQuery = {
  readonly track: string;
  /** "intent" (default) uses the track's own exportPresets; "full" wants every platform. */
  readonly mode?: ContentPackageMode;
  /** Overrides mode with an exact platform set. Repeatable query param. */
  readonly platforms?: readonly PlatformId[];
};

/* ------------------------------------------------------------------ *
 * Batch Content Package Generation
 *
 * Select several tracks, inspect/plan/apply their content packages
 * together. Every endpoint reuses `deriveContentPackage` per track (the
 * exact function GET /api/content-package uses for one) and the existing
 * render queue (`renderManager`/render-batches) — this is orchestration and
 * aggregation on top of what already exists, not a second engine. See
 * core/domain/content/contentPackageBatch.ts for the derivation.
 * ------------------------------------------------------------------ */

/** Shared by inspect/plan/apply. `tracks` is always explicit — never "the catalogue" by omission. */
export type ContentPackageBatchBody = {
  readonly tracks: readonly string[];
  readonly mode?: Exclude<ContentPackageMode, "custom">;
  readonly platforms?: readonly PlatformId[];
};

/** POST /api/content-package/batch/apply request body. */
export type ContentPackageBatchApplyBody = ContentPackageBatchBody & {
  /** Wait for the queued render batch to settle before responding, up to `timeoutMs`. */
  readonly wait?: boolean;
  /** Bounded; a timeout only means this call stopped waiting, never that anything was cancelled. */
  readonly timeoutMs?: number;
};

/** One platform/preset target's planned action, at plan or apply time. */
export type ContentPackagePlannedActionView = {
  readonly slug: string;
  readonly platformId: PlatformId;
  readonly presetId: RenderPresetId;
  readonly label: string;
  readonly kind: ContentPackageActionKind;
  readonly staleReasons: readonly StaleReason[];
  /** Set only for `blocked` actions. */
  readonly reason: string | null;
};

/** POST /api/content-package/batch/plan. Read-only — nothing is queued. */
export type ContentPackageBatchPlanView = {
  readonly mode: ContentPackageMode;
  readonly tracks: number;
  /** render_missing/rerender_stale actions, de-duplicated by track+preset. */
  readonly renderable: readonly ContentPackagePlannedActionView[];
  /** Already queued/rendering elsewhere — apply will follow, not requeue, these. */
  readonly adopted: readonly ContentPackagePlannedActionView[];
  readonly ready: readonly ContentPackagePlannedActionView[];
  readonly blocked: readonly ContentPackagePlannedActionView[];
  readonly invalid: readonly BatchInvalidTrackEntry[];
  readonly duplicates: readonly string[];
};

/**
 * POST /api/content-package/batch/apply.
 *
 * Re-plans from current state immediately before queueing — never the plan a
 * caller might already be holding from /plan — so nothing here trusts a
 * stale client-side plan (§10, "plan revalidation"). `renderBatch` is the
 * render-batches aggregate at response time; follow `batchId` via
 * GET /api/render-batches/:id/events for live progress, exactly like
 * /api/export-missing.
 */
export type ContentPackageBatchApplyView = {
  readonly mode: ContentPackageMode;
  readonly tracks: number;
  readonly batchId: string | null;
  readonly renderBatch: RenderBatchView | null;
  /** Exact action → render job correlation returned by the server at Apply time. */
  readonly jobReferences: readonly ContentPackageBatchJobReferenceView[];
  /** True only when `wait` was requested and the batch had not settled by `timeoutMs`. */
  readonly timedOut: boolean;
  readonly queued: readonly ContentPackagePlannedActionView[];
  readonly adopted: readonly ContentPackagePlannedActionView[];
  readonly alreadyReady: readonly ContentPackagePlannedActionView[];
  readonly blocked: readonly ContentPackagePlannedActionView[];
  /** Targets another process holds a render lock on, left out of the batch. */
  readonly lockedElsewhere: readonly ContentPackagePlannedActionView[];
  readonly invalid: readonly BatchInvalidTrackEntry[];
  readonly duplicates: readonly string[];
  /** True when every renderable target was already ready, in flight, or blocked. */
  readonly nothingToDo: boolean;
};

export type ContentPackageBatchJobReferenceView = {
  readonly actionId: string;
  readonly slug: string;
  readonly platformId: PlatformId;
  readonly presetId: RenderPresetId;
  readonly jobId: string | null;
  readonly outcome: "queued" | "adopted" | "locked_elsewhere";
};

/**
 * GET /api/content-metadata-settings, and the response to a PATCH.
 *
 * `templates` is only what has actually been overridden globally — a track
 * that inherits everything is not represented here at all. Built-in defaults
 * are not sent over the wire: they are a fixed constant
 * (`BUILT_IN_DEFAULT_TEMPLATES`) the UI already has from the shared domain
 * module, so there is exactly one copy of them, not two that could drift.
 */
export type ContentMetadataSettingsView = {
  readonly schemaVersion: number;
  readonly revision: string;
  readonly templates: PartialMetadataTemplates;
  /**
   * Set when the settings file exists but could not be read (malformed
   * JSON, wrong shape). Never set just because the file is absent — that
   * means "nothing configured yet", not corruption. Built-in defaults are
   * still used either way; this is what makes the difference visible rather
   * than silently hidden.
   */
  readonly problem: string | null;
  /** Where the machine-local setting is stored, for the UI to name. */
  readonly settingsPath: string;
};

/**
 * PATCH /api/content-metadata-settings request body.
 *
 * Each leaf is a validated template string (set it), `null` (reset that one
 * field to the built-in default), or omitted (leave it alone) — a field-by-
 * field reset patch, not a whole-object replace, because resetting one
 * template should not disturb every other one a user already configured.
 */
export type ContentMetadataSettingsPatch = MetadataTemplatesResetPatch;

/* ------------------------------------------------------------------ *
 * Delivery history
 * ------------------------------------------------------------------ */

/**
 * Query parameters for GET /api/delivery-history.
 *
 * All optional, all validated server-side, and the limit is bounded whether or
 * not one is given. No path is accepted: the destination whose history is read
 * comes from stored settings, exactly as it does for delivery itself.
 */
export type DeliveryHistoryQuery = {
  readonly track?: string;
  readonly preset?: string;
  /** Inclusive ISO lower bound, or a relative period such as "7d" or "24h". */
  readonly from?: string;
  /** Exclusive ISO upper bound. */
  readonly to?: string;
  readonly limit?: number;
  readonly order?: DeliveryHistoryOrder;
};

/** GET /api/delivery-history */
export type DeliveryHistoryView = {
  readonly root: string | null;
  readonly rootProblem: string | null;
  /** Whether the log could be read whole, and how it is damaged if not. */
  readonly status: DeliveryLogStatus;
  /** A note for the user about the status, when there is anything to say. */
  readonly statusNote: string | null;
  readonly problems: readonly DeliveryLogProblem[];
  /** Events matching the query, ordered and limited. */
  readonly events: readonly DeliveryLogEvent[];
  /** How many matched the query before the limit was applied. */
  readonly matched: number;
  readonly limit: number;
  /** Counts for the whole destination, not just the filtered events. */
  readonly summary: DeliveryHistorySummary;
  /** Tracks appearing anywhere in the log, for a filter list. */
  readonly knownTracks: readonly { readonly slug: string; readonly title: string }[];
  /**
   * Ids of returned events that are not the first time that track and format
   * went out. Decided against the whole log, because a page of recent events
   * cannot tell whether something older came before it.
   */
  readonly redelivered: readonly string[];
};

/**
 * POST /api/delivery-history/reconcile
 *
 * Appends events for deliveries whose receipts exist but that were never
 * recorded — the one thing a crash between the two can leave behind. It reads
 * receipts only, never invents a timestamp, and is idempotent.
 */
export type DeliveryHistoryReconcileView = {
  readonly root: string | null;
  readonly rootProblem: string | null;
  readonly scanned: number;
  readonly alreadyRecorded: number;
  readonly appended: readonly DeliveryLogEvent[];
  /** Receipts that could not be turned into an event, with the reason. */
  readonly unreconcilable: readonly {
    readonly slug: string;
    readonly presetId: string;
    readonly reason: string;
  }[];
  readonly problem: string | null;
};

/* ------------------------------------------------------------------ *
 * Destination health
 * ------------------------------------------------------------------ */

/**
 * One track's destination-drift findings.
 *
 * `folder` is the track's effective delivery folder, even when there are no
 * findings — so a clean result can still say where it looked.
 */
export type DestinationTrackHealthView = {
  readonly slug: string;
  readonly folder: string | null;
  readonly findings: readonly DestinationFinding[];
};

/**
 * GET /api/destination-health
 *
 * Compares what current delivery receipts and release bundles say should be
 * at the destination against what a filesystem sweep actually finds there.
 * Read-only: nothing here is ever written or deleted. A snapshot, not a
 * transaction — see `scannedAt`.
 */
export type DestinationHealthView = {
  readonly status: DestinationHealthStatus;
  /** True for a whole-catalogue scan; false when specific tracks were named. */
  readonly catalogue: boolean;
  readonly root: string | null;
  readonly rootProblem: string | null;
  /** Findings about the destination itself, not any one track. */
  readonly rootFindings: readonly DestinationFinding[];
  readonly tracks: readonly DestinationTrackHealthView[];
  readonly counts: DestinationHealthCounts;
  /** When this scan ran. Held in memory only — nothing here is cached to disk. */
  readonly scannedAt: string;
  /** Named tracks that could not be scanned at all (not found locally). */
  readonly invalid: readonly { readonly slug: string; readonly reason: string }[];
};

/* ------------------------------------------------------------------ *
 * Destination fix plan
 * ------------------------------------------------------------------ */

/**
 * POST /api/destination-health/plan and /api/destination-health/apply-plan
 * request body.
 *
 * Mirrors delivery and export-missing: name tracks, or ask for the catalogue
 * outright. `apply-plan` additionally names which proposed action ids to run;
 * the server re-derives the plan fresh and only ever acts on an id that plan
 * still produces itself, so nothing here can smuggle in an arbitrary path or
 * operation.
 */
export type DestinationFixPlanBody = {
  readonly tracks?: readonly string[];
  readonly catalogue?: boolean;
};

export type DestinationFixApplyBody = DestinationFixPlanBody & {
  readonly actionIds: readonly string[];
  /**
   * Follow a rerender_and_deliver action's render job through to a final,
   * confirmed result before this call returns, instead of returning `queued`
   * immediately. Off by default.
   */
  readonly waitForCompletion?: boolean;
  /** Bounded wait in milliseconds; default 5 minutes, capped at 30. */
  readonly timeoutMs?: number;
  /** Exact job ids returned by an earlier queued apply, keyed by action id. */
  readonly followJobs?: readonly { readonly actionId: string; readonly jobId: string }[];
};

/**
 * POST /api/destination-health/plan
 *
 * A dry-run remediation plan, built from a fresh destination health scan.
 * Nothing here writes or deletes anything — it only proposes, grouped into
 * `safe` (executable, reusing an existing non-destructive operation) and
 * `manual` (never run automatically; most often because it would mean
 * deleting or replacing a file this app did not itself deliver).
 */
export type DestinationFixPlanView = {
  readonly status: DestinationHealthStatus;
  readonly catalogue: boolean;
  readonly root: string | null;
  readonly rootProblem: string | null;
  readonly scannedAt: string;
  readonly findings: readonly DestinationFinding[];
  readonly actions: readonly RemediationAction[];
  readonly summary: RemediationPlanSummary;
  readonly invalid: readonly { readonly slug: string; readonly reason: string }[];
};

/**
 * POST /api/destination-health/apply-plan
 *
 * Runs the named safe actions, each revalidated against current state right
 * before it runs. `plan` is the fresh plan this call re-derived to validate
 * against — not the stale one the caller may have been looking at.
 */
export type DestinationFixApplyView = {
  readonly plan: DestinationFixPlanView;
  readonly results: readonly RemediationActionResult[];
};

/* ------------------------------------------------------------------ *
 * Operator-facing render history (durable journal, one track)
 * ------------------------------------------------------------------ */

/**
 * One historical render, as `GET /api/render-history` reports it — always a
 * job the durable journal remembers, never a live one (a live job is
 * answered by `GET /api/renders/:id`/its SSE stream, not this endpoint).
 * Grouped by job: one entry per job's final reconstructed state, never one
 * per lifecycle event (core/domain/render/renderJournal.ts's
 * `recentRenderJobsForSlug`).
 *
 * Deliberately as narrow as `RenderJobView`'s own historical fields — no
 * progress, no output path, nothing the journal itself never recorded.
 */
export type RenderHistoryJobView = {
  readonly jobId: string;
  readonly slug: string;
  readonly presetId: RenderPresetId;
  /**
   * Never "queued"/"preparing"/"rendering": every job this endpoint reports
   * has already settled from the durable journal's point of view, exactly
   * like `classifyRecoveredJob`'s own guarantee.
   */
  readonly status: "completed" | "failed" | "cancelled" | "interrupted";
  readonly recordedAt: string;
  readonly historical: true;
  readonly recoveredAfterRestart: boolean;
  readonly error: RenderJobError | null;
};

/** GET /api/render-history query. */
export type RenderHistoryQuery = {
  readonly track: string;
  readonly limit?: number;
};

/**
 * GET /api/render-history?track=<slug>&limit=<n>
 *
 * Read-only summary of one track's most recent renders, sourced entirely
 * from the durable render journal (never from package readiness, delivery,
 * or the live render manager — see core/domain/render/renderJournal.ts).
 * Mirrors `DeliveryHistoryView`'s own status/statusNote split: a damaged
 * journal still reports whatever history could be read, with `status`/
 * `statusNote` saying so rather than the endpoint failing outright.
 */
export type RenderHistoryView = {
  readonly slug: string;
  readonly status: RenderJournalStatus;
  readonly statusNote: string | null;
  /** Newest first, bounded by `limit`. */
  readonly jobs: readonly RenderHistoryJobView[];
  readonly limit: number;
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

/** Delivery history types, re-exported so clients need one import. */
export type {
  DeliveryHistoryOrder,
  DeliveryHistorySummary,
  DeliveryLogEvent,
  DeliveryLogProblem,
  DeliveryLogStatus,
};

/** Render journal status, re-exported so clients need one import. */
export type { RenderJournalStatus };

/** Destination health types, re-exported so clients need one import. */
export type {
  DestinationFinding,
  DestinationFindingCode,
  DestinationFindingSeverity,
  DestinationHealthCounts,
  DestinationHealthStatus,
} from "../delivery/destinationHealth.ts";

/** Destination fix plan types, re-exported so clients need one import. */
export type {
  RemediationAction,
  RemediationActionKind,
  RemediationActionResult,
  RemediationOutcomeStatus,
  RemediationPlanSummary,
  RemediationSafety,
} from "../delivery/destinationFixPlan.ts";

/** Content package types, re-exported so clients need one import. */
export type {
  ContentPackageCounts,
  ContentPackageMode,
  ContentPackagePlatformEntry,
  ContentPackageStatus,
  ContentPackageView,
  PlatformAction,
  PlatformReadiness,
} from "../content/contentPackage.ts";
/** Batch content package types, re-exported so clients need one import. */
export type {
  BatchContentPackageTotals,
  BatchContentPackageView,
  BatchInvalidTrackEntry,
  BatchTrackEntry,
  ContentPackageActionKind,
} from "../content/contentPackageBatch.ts";
export type {
  PlatformId,
  PlatformProfile,
} from "../content/platformProfiles.ts";
export type { PlatformMetadata, PlatformMetadataSubject } from "../content/platformMetadata.ts";

/** Metadata template types, re-exported so clients need one import. */
export type {
  CaptionTemplateFields,
  MetadataTemplates,
  MetadataTemplatesResetPatch,
  PartialMetadataTemplates,
  PlaceholderKey,
  YoutubeTemplateFields,
} from "../content/metadataTemplates.ts";

/* ------------------------------------------------------------------ *
 * Content library
 * ------------------------------------------------------------------ */

/** Whether per-version delivery facts could be attributed, and if not, why. */
export type ContentLibraryDeliveryAvailability = "not_configured" | "available" | "unavailable";

/**
 * GET /api/content-library
 *
 * Mirrors `DeliveryHistoryView`'s status/statusNote split: a damaged library
 * still returns every record that could be read, with `status`/`statusNote`
 * saying so rather than the endpoint failing outright.
 */
export type ContentLibraryView = {
  readonly status: ContentLibraryStatus;
  readonly statusNote: string | null;
  readonly problems: readonly ContentLibraryProblem[];
  /** Entries matching the query, ordered and limited. Status is derived, never stored. */
  readonly entries: readonly ContentLibraryEntry[];
  /** How many matched before the limit was applied. */
  readonly matched: number;
  readonly limit: number;
  /** Over the whole library, or over one track when the query names one. */
  readonly summary: ContentLibrarySummary;
  readonly knownTracks: readonly { readonly slug: string; readonly title: string }[];
  readonly knownPresets: readonly { readonly id: string; readonly label: string }[];
  /** Which formats the named track has had generated; null without a track filter. */
  readonly formats: readonly LibraryFormatSummary[] | null;
  readonly deliveries: ContentLibraryDeliveryAvailability;
};

/** GET /api/content-library/:recordId */
export type ContentLibraryRecordView = {
  readonly entry: ContentLibraryEntry;
  /** Every version of the same track and format, oldest first. */
  readonly versions: readonly ContentLibraryEntry[];
  readonly reexport: { readonly allowed: boolean; readonly reason: string | null };
  readonly deliveries: ContentLibraryDeliveryAvailability;
};

/** POST /api/content-library/:recordId/reexport — a normal one-target render batch. */
export type ContentLibraryReexportView = {
  readonly recordId: string;
  readonly batch: RenderBatchView;
};

/** POST /api/content-library/adopt */
export type ContentLibraryAdoptView = {
  readonly adopted: number;
  readonly alreadyRecorded: number;
  readonly skipped: readonly { readonly slug: string; readonly presetId: string; readonly reason: string }[];
  readonly problems: readonly string[];
};
