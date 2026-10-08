import type { TrackIssue } from "./errors.ts";
import type { TrackAssetPaths } from "./paths.ts";
import type { PartialMetadataTemplates } from "../content/metadataTemplates.ts";
import type { EngagementSelection } from "../content/engagementOptimizer.ts";
import type { RenderPresetId } from "../video/renderPresets.ts";
import type { RendererId } from "../video/renderers.ts";

/** A track whose metadata is complete and renderable. */
export type TrackMetadata = {
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: number;
  readonly subtitle?: string;
  /**
   * Which formats this track is meant to ship in.
   *
   * Absent means undeclared, which resolves to every supported format — see
   * resolveExportPresets(). Stored in canonical preset order with no
   * duplicates.
   */
  readonly exportPresets?: readonly RenderPresetId[];
  /**
   * Which renderer this track's videos should come from. Absent means
   * undeclared, which resolves to the default (Remotion) — see
   * resolveTrackRenderer(). A preference, not an installation fact: whether
   * that renderer can run on this machine is checked when a render is asked
   * for. The UI renders with it; CLI and API callers name an engine
   * explicitly (or get the default), exactly as before.
   */
  readonly renderer?: RendererId;
  /**
   * Which folder this track delivers into, inside the configured export
   * destination. Absent means the slug. Deliberately a portable folder name,
   * never a machine path — absolute destinations are local configuration.
   */
  readonly deliveryFolder?: string;
  /**
   * Per-track overrides for content package metadata templates (YouTube
   * title/description/keywords, Reels/Instagram caption/hashtags). Absent
   * means every field inherits the global template, or the built-in default
   * when no global template is set either — see resolveMetadataTemplates().
   * Never affects rendered video: only fields actually passed to the
   * composition (title/artist/key/bpm/subtitle) do that.
   */
  readonly contentMetadataOverrides?: PartialMetadataTemplates;
  /**
   * The Engagement Optimizer's saved choices (hook, caption style). Copy
   * only: never passed to a renderer and not part of any export fingerprint,
   * so changing it never re-renders or stales an export. See
   * core/domain/content/engagementOptimizer.ts.
   */
  readonly engagement?: EngagementSelection;
};

/**
 * Metadata as it may actually exist on disk. `new-track` scaffolds
 * `key: ""` / `bpm: null` on purpose, so a freshly created track is a valid
 * draft but not yet renderable.
 */
export type TrackMetadataDraft = {
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: number | null;
  readonly subtitle?: string;
  /**
   * Which formats this track is meant to ship in.
   *
   * Absent means undeclared, which resolves to every supported format — see
   * resolveExportPresets(). Stored in canonical preset order with no
   * duplicates.
   */
  readonly exportPresets?: readonly RenderPresetId[];
  /** See TrackMetadata.renderer. */
  readonly renderer?: RendererId;
  /**
   * Which folder this track delivers into, inside the configured export
   * destination. Absent means the slug. Deliberately a portable folder name,
   * never a machine path — absolute destinations are local configuration.
   */
  readonly deliveryFolder?: string;
  /** See TrackMetadata.contentMetadataOverrides. */
  readonly contentMetadataOverrides?: PartialMetadataTemplates;
  /**
   * The Engagement Optimizer's saved choices (hook, caption style). Copy
   * only: never passed to a renderer and not part of any export fingerprint,
   * so changing it never re-renders or stales an export. See
   * core/domain/content/engagementOptimizer.ts.
   */
  readonly engagement?: EngagementSelection;
};

/**
 * - ready:      renderable right now
 * - draft:      scaffolded, still waiting on key/bpm
 * - incomplete: a required file is missing
 * - invalid:    metadata.json is present but malformed
 */
export type TrackStatus = "ready" | "draft" | "incomplete" | "invalid";

/** What the filesystem says about a track. Observed by services, interpreted by the domain. */
export type TrackAssetFacts = {
  readonly trackDirExists: boolean;
  readonly coverExists: boolean;
  readonly beatExists: boolean;
  readonly metadataExists: boolean;
  readonly analysisExists: boolean;
  /** analysis.wav exists and is at least as new as beat.wav. */
  readonly analysisUpToDate: boolean;
  /** True when any render exists for this track, in any format. */
  readonly outputExists: boolean;
  /** Which formats have been rendered, by preset id. */
  readonly renderedPresets: readonly RenderPresetId[];
  /** A render from before presets existed, at out/<slug>.mp4. */
  readonly legacyOutputExists: boolean;
};

export type ValidationResult = {
  readonly ok: boolean;
  readonly errors: readonly TrackIssue[];
  readonly warnings: readonly TrackIssue[];
};

export type TrackInspection = {
  readonly slug: string;
  readonly status: TrackStatus;
  readonly facts: TrackAssetFacts;
  /** Only set when metadata.json is present and fully valid. */
  readonly metadata: TrackMetadata | null;
  /**
   * Whatever metadata.json currently holds, coerced field by field and never
   * rejected — so an editor can prefill a draft or a not-yet-valid track.
   * Null when the file is absent or is not a JSON object at all.
   */
  readonly metadataDraft: TrackMetadataDraft | null;
  /** Opaque revision for conditional metadata saves; null when absent. */
  readonly metadataRevision: string | null;
  readonly validation: ValidationResult;
  /** public/-relative paths for this track's files. */
  readonly paths: TrackAssetPaths;
};
