import type { TrackIssue } from "./errors.ts";
import type { TrackAssetPaths } from "./paths.ts";
import type { RenderPresetId } from "../video/renderPresets.ts";

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
   * Which folder this track delivers into, inside the configured export
   * destination. Absent means the slug. Deliberately a portable folder name,
   * never a machine path — absolute destinations are local configuration.
   */
  readonly deliveryFolder?: string;
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
  /**
   * Which folder this track delivers into, inside the configured export
   * destination. Absent means the slug. Deliberately a portable folder name,
   * never a machine path — absolute destinations are local configuration.
   */
  readonly deliveryFolder?: string;
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
