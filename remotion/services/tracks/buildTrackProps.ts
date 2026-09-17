import type { BeatVisualizerProps } from "../../src/BeatVisualizer/BeatVisualizer.ts";
import {
  BRAND_ASSET_PATHS,
  trackAssetPaths,
} from "../../src/domain/tracks/paths.ts";
import type { TrackMetadata } from "../../src/domain/tracks/types.ts";

export type BuildTrackPropsInput = {
  readonly slug: string;
  readonly metadata: TrackMetadata;
  /** When false, the waveform falls back to reading beat.wav directly. */
  readonly analysisAvailable: boolean;
};

/**
 * Maps a track's metadata and asset layout onto the composition's props.
 *
 * Every *Src value stays relative to public/ — BeatVisualizer calls
 * staticFile() on them itself, so the same props work in the Studio, in a
 * programmatic render, and in a future Player preview.
 */
export const buildTrackProps = ({
  slug,
  metadata,
  analysisAvailable,
}: BuildTrackPropsInput): BeatVisualizerProps => {
  const paths = trackAssetPaths(slug);

  return {
    title: metadata.title,
    artist: metadata.artist,
    musicalKey: metadata.key,
    bpm: metadata.bpm,
    subtitle: metadata.subtitle,
    coverSrc: paths.cover,
    audioSrc: paths.beat,
    waveformAudioSrc: analysisAvailable ? paths.analysis : undefined,
    brandLogoSrc: BRAND_ASSET_PATHS.logoLight,
    brandBadgeSrc: BRAND_ASSET_PATHS.iconMark,
  };
};
