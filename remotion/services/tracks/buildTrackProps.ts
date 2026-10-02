import type { VisualizerProps } from "../../core/domain/video/visualizerProps.ts";
import {
  BRAND_ASSET_PATHS,
  trackAssetPaths,
} from "../../core/domain/tracks/paths.ts";
import type { TrackMetadata } from "../../core/domain/tracks/types.ts";
import type { RenderPresetId } from "../../core/domain/video/renderPresets.ts";

export type BuildTrackPropsInput = {
  readonly slug: string;
  readonly metadata: TrackMetadata;
  /** When false, the waveform falls back to reading beat.wav directly. */
  readonly analysisAvailable: boolean;
  /**
   * Format to render. Left out for the default 16:9, so props built by older
   * callers are byte-for-byte what they were.
   */
  readonly presetId?: RenderPresetId;
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
  presetId,
}: BuildTrackPropsInput): VisualizerProps => {
  const paths = trackAssetPaths(slug);

  return {
    ...(presetId === undefined ? {} : { presetId }),
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
