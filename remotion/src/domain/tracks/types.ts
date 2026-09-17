import type { TrackIssue } from "./errors.ts";
import type { TrackAssetPaths } from "./paths.ts";

/** A track whose metadata is complete and renderable. */
export type TrackMetadata = {
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: number;
  readonly subtitle?: string;
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
  readonly outputExists: boolean;
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
  readonly validation: ValidationResult;
  /** public/-relative paths for this track's files. */
  readonly paths: TrackAssetPaths;
};
