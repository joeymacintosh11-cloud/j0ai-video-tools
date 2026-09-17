import type { BeatVisualizerProps } from "../../src/BeatVisualizer/BeatVisualizer.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import {
  publicLabel,
  trackAssetPaths,
} from "../../src/domain/tracks/paths.ts";
import type {
  TrackInspection,
  TrackMetadata,
} from "../../src/domain/tracks/types.ts";
import { isAssetIssue } from "../../src/domain/tracks/validation.ts";
import { buildTrackProps } from "./buildTrackProps.ts";
import { inspectTrack } from "./inspectTrack.ts";
import {
  ensureAnalysisAudio,
  type AnalysisAudioResult,
} from "./prepareTrackAudio.ts";

export type PrepareTrackResult = {
  readonly slug: string;
  readonly metadata: TrackMetadata;
  readonly props: BeatVisualizerProps;
  readonly analysis: AnalysisAudioResult;
  /** State observed before preparation ran. */
  readonly inspection: TrackInspection;
};

/**
 * The single path every consumer takes to get a renderable track:
 * validate the folder, refresh the waveform analysis audio, and resolve the
 * composition props. "Validating" and "preparing" a track therefore always
 * mean exactly the same thing.
 *
 * Throws TrackError on the first blocking problem. Callers that want the full
 * picture without throwing should use inspectTrack() instead.
 */
export const prepareTrack = async (
  slug: string,
): Promise<PrepareTrackResult> => {
  const inspection = await inspectTrack(slug);

  // Missing files come first: nothing downstream can run without them, and
  // analysis audio in particular needs beat.wav to exist.
  const assetErrors = inspection.validation.errors.filter(isAssetIssue);
  if (assetErrors.length > 0) {
    throw new TrackError(assetErrors[0]);
  }

  const analysis = await ensureAnalysisAudio(slug);

  const metadataErrors = inspection.validation.errors.filter(
    (issue) => !isAssetIssue(issue),
  );
  if (metadataErrors.length > 0) {
    throw new TrackError(metadataErrors[0]);
  }

  const metadata = inspection.metadata;
  if (metadata === null) {
    const source = publicLabel(trackAssetPaths(slug).metadata);
    throw new TrackError(
      trackIssue("METADATA_INVALID", `${source} could not be read.`, source),
    );
  }

  return {
    slug,
    metadata,
    props: buildTrackProps({ slug, metadata, analysisAvailable: true }),
    analysis,
    inspection,
  };
};
