import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { trackIssue, type TrackIssue } from "../../src/domain/tracks/errors.ts";
import {
  coerceMetadataDraft,
  isDraftMetadata,
  validateTrackMetadata,
} from "../../src/domain/tracks/metadata.ts";
import {
  publicLabel,
  trackAssetPaths,
} from "../../src/domain/tracks/paths.ts";
import type {
  TrackAssetFacts,
  TrackInspection,
} from "../../src/domain/tracks/types.ts";
import {
  buildValidationResult,
  collectTrackWarnings,
  deriveTrackStatus,
  validateTrackAssets,
} from "../../src/domain/tracks/validation.ts";
import { trackLocations } from "./trackLocations.ts";

const mtimeMs = (filePath: string): number | null =>
  existsSync(filePath) ? statSync(filePath).mtimeMs : null;

const observeFacts = (slug: string): TrackAssetFacts => {
  const locations = trackLocations(slug);

  const beatMtime = mtimeMs(locations.beat);
  const analysisMtime = mtimeMs(locations.analysis);

  return {
    trackDirExists: existsSync(locations.trackDir),
    coverExists: existsSync(locations.cover),
    beatExists: beatMtime !== null,
    metadataExists: existsSync(locations.metadata),
    analysisExists: analysisMtime !== null,
    analysisUpToDate:
      analysisMtime !== null && beatMtime !== null && analysisMtime >= beatMtime,
    outputExists: existsSync(locations.output),
  };
};

const readMetadataIssues = async (
  slug: string,
): Promise<{
  readonly issues: readonly TrackIssue[];
  readonly metadata: TrackInspection["metadata"];
  readonly metadataDraft: TrackInspection["metadataDraft"];
  readonly isDraft: boolean;
}> => {
  const locations = trackLocations(slug);
  const source = publicLabel(trackAssetPaths(slug).metadata);
  const raw = await readFile(locations.metadata, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      issues: [
        trackIssue(
          "METADATA_INVALID",
          `${source} is not valid JSON: ${reason}`,
          source,
        ),
      ],
      metadata: null,
      metadataDraft: null,
      isDraft: false,
    };
  }

  const { issues, metadata } = validateTrackMetadata(parsed, source);

  return {
    issues,
    metadata,
    metadataDraft: coerceMetadataDraft(parsed),
    isDraft: isDraftMetadata(parsed),
  };
};

/**
 * Reports everything knowable about a track without throwing for any
 * user-fixable problem — missing files and bad metadata come back as
 * structured issues so a list view can render them all.
 */
export const inspectTrack = async (slug: string): Promise<TrackInspection> => {
  const facts = observeFacts(slug);
  const assetIssues = validateTrackAssets(slug, facts);

  const {
    issues: metadataIssues,
    metadata,
    metadataDraft,
    isDraft,
  } = facts.metadataExists
    ? await readMetadataIssues(slug)
    : {
        issues: [] as readonly TrackIssue[],
        metadata: null,
        metadataDraft: null,
        isDraft: false,
      };

  const validation = buildValidationResult(
    assetIssues,
    metadataIssues,
    collectTrackWarnings(slug, facts),
  );

  return {
    slug,
    status: deriveTrackStatus(validation, assetIssues, isDraft),
    facts,
    metadata,
    metadataDraft,
    validation,
    paths: trackAssetPaths(slug),
  };
};
