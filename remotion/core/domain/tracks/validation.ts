import {
  trackIssue,
  type TrackErrorCode,
  type TrackIssue,
} from "./errors.ts";
import { publicLabel, trackAssetPaths, trackDirLabel } from "./paths.ts";
import type {
  TrackAssetFacts,
  TrackStatus,
  ValidationResult,
} from "./types.ts";

/**
 * Issues about files being present at all, as opposed to metadata content.
 * These block everything downstream — you can't build analysis audio without
 * beat.wav — so callers treat them as a hard stop before doing any work.
 */
export const ASSET_ISSUE_CODES: readonly TrackErrorCode[] = [
  "TRACK_NOT_FOUND",
  "COVER_MISSING",
  "AUDIO_MISSING",
  "METADATA_MISSING",
];

export const isAssetIssue = (issue: TrackIssue): boolean =>
  ASSET_ISSUE_CODES.includes(issue.code);

/** Reported in the order the CLI has always surfaced them. */
export const validateTrackAssets = (
  slug: string,
  facts: TrackAssetFacts,
): readonly TrackIssue[] => {
  if (!facts.trackDirExists) {
    return [
      trackIssue(
        "TRACK_NOT_FOUND",
        `Track "${slug}" not found. Expected a folder at public/tracks/${slug}/ ` +
          `containing cover.png, beat.wav and metadata.json.`,
        trackDirLabel(slug),
      ),
    ];
  }

  const paths = trackAssetPaths(slug);
  const issues: TrackIssue[] = [];

  if (!facts.coverExists) {
    issues.push(
      trackIssue(
        "COVER_MISSING",
        `Track "${slug}" is missing cover art: ${publicLabel(paths.cover)}`,
        publicLabel(paths.cover),
      ),
    );
  }

  if (!facts.beatExists) {
    issues.push(
      trackIssue(
        "AUDIO_MISSING",
        `Track "${slug}" is missing audio: ${publicLabel(paths.beat)}`,
        publicLabel(paths.beat),
      ),
    );
  }

  if (!facts.metadataExists) {
    issues.push(
      trackIssue(
        "METADATA_MISSING",
        `Track "${slug}" is missing metadata: ${publicLabel(paths.metadata)}`,
        publicLabel(paths.metadata),
      ),
    );
  }

  return issues;
};

/**
 * A missing or stale analysis.wav is a warning, not an error: preparation
 * regenerates it automatically rather than asking the user to fix anything.
 */
export const collectTrackWarnings = (
  slug: string,
  facts: TrackAssetFacts,
): readonly TrackIssue[] => {
  if (!facts.beatExists || facts.analysisUpToDate) {
    return [];
  }

  const analysisPath = publicLabel(trackAssetPaths(slug).analysis);

  return [
    trackIssue(
      "ANALYSIS_STALE",
      facts.analysisExists
        ? `${analysisPath} is older than beat.wav and will be regenerated.`
        : `${analysisPath} has not been generated yet and will be created.`,
      analysisPath,
    ),
  ];
};

export const buildValidationResult = (
  assetIssues: readonly TrackIssue[],
  metadataIssues: readonly TrackIssue[],
  warnings: readonly TrackIssue[],
): ValidationResult => {
  const errors = [...assetIssues, ...metadataIssues];

  return { ok: errors.length === 0, errors, warnings };
};

export const deriveTrackStatus = (
  validation: ValidationResult,
  assetIssues: readonly TrackIssue[],
  isDraft: boolean,
): TrackStatus => {
  if (assetIssues.length > 0) {
    return "incomplete";
  }
  if (validation.errors.length === 0) {
    return "ready";
  }
  return isDraft ? "draft" : "invalid";
};
