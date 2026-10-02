import { Composition } from "remotion";
import {
  BeatVisualizer,
  calculateBeatVisualizerMetadata,
} from "./BeatVisualizer/BeatVisualizer";
import { parseTrackMetadata } from "../../core/domain/tracks/metadata";
import { BRAND_ASSET_PATHS, trackAssetPaths, publicLabel } from "../../core/domain/tracks/paths";
import { COMPOSITION_CONFIG } from "../../core/domain/video/compositionConfig";
import previewTrackMetadataJson from "../../public/tracks/ghetto-geek/metadata.json";

// The Studio preview always shows one track by default. Any track in
// public/tracks/<slug>/ can be rendered via `npm run render-track -- <slug>`,
// which resolves its own props from that track's metadata.json instead of
// using these defaults (see scripts/render-track.mts).
const PREVIEW_TRACK_SLUG = "ghetto-geek";
const previewPaths = trackAssetPaths(PREVIEW_TRACK_SLUG);
const previewTrackMetadata = parseTrackMetadata(
  previewTrackMetadataJson,
  publicLabel(previewPaths.metadata),
);

export const ToshiBeatVisualizerComposition = () => {
  return (
    <Composition
      id={COMPOSITION_CONFIG.id}
      component={BeatVisualizer}
      fps={COMPOSITION_CONFIG.fps}
      width={COMPOSITION_CONFIG.width}
      height={COMPOSITION_CONFIG.height}
      durationInFrames={150}
      defaultProps={{
        title: previewTrackMetadata.title,
        artist: previewTrackMetadata.artist,
        musicalKey: previewTrackMetadata.key,
        bpm: previewTrackMetadata.bpm,
        subtitle: previewTrackMetadata.subtitle,
        coverSrc: previewPaths.cover,
        audioSrc: previewPaths.beat,
        brandLogoSrc: BRAND_ASSET_PATHS.logoLight,
        brandBadgeSrc: BRAND_ASSET_PATHS.iconMark,
      }}
      calculateMetadata={calculateBeatVisualizerMetadata}
    />
  );
};
