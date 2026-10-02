import type { RenderPreset } from "./renderPresets.ts";
import type { VisualizerProps } from "./visualizerProps.ts";

/**
 * The data a template-driven renderer needs to draw one track, as plain JSON.
 *
 * Renderers that fill a template made in another application (an After
 * Effects project today, a Premiere Pro template later) cannot import
 * VisualizerProps; they read a sidecar file instead. This is that file's one
 * definition, so every such renderer gets the same fields with the same
 * meaning, and a template author has a stable contract to build against.
 *
 * Pure: asset paths are turned into whatever the renderer can open by the
 * `resolveAsset` the caller supplies (absolute paths, for After Effects).
 *
 * Bump TEMPLATE_DATA_SCHEMA_VERSION on any breaking change to the shape;
 * adding a field is not breaking.
 */

export const TEMPLATE_DATA_SCHEMA_VERSION = 1;

export type TemplateData = {
  readonly schemaVersion: typeof TEMPLATE_DATA_SCHEMA_VERSION;
  readonly track: {
    readonly title: string;
    readonly artist: string;
    /** The musical key, e.g. "F Minor". */
    readonly key: string;
    readonly bpm: number;
    readonly subtitle: string | null;
  };
  readonly assets: {
    readonly cover: string;
    readonly audio: string;
    /** The lightweight waveform-analysis audio; the full audio when absent. */
    readonly waveformAudio: string;
    readonly brandLogo: string;
    readonly brandBadge: string;
  };
  readonly format: {
    readonly presetId: RenderPreset["id"];
    readonly width: number;
    readonly height: number;
    readonly fps: number;
    readonly aspectRatio: string;
    /** "landscape" | "portrait" | "square" — what a template branches on. */
    readonly layout: RenderPreset["layout"];
  };
  readonly timing: {
    readonly fps: number;
    readonly durationInFrames: number;
    readonly durationInSeconds: number;
  };
};

export const buildTemplateData = (input: {
  readonly props: VisualizerProps;
  readonly preset: RenderPreset;
  readonly durationInFrames: number;
  /** Turns a public/-relative asset path into one the renderer can open. */
  readonly resolveAsset: (publicRelativePath: string) => string;
}): TemplateData => {
  const { props, preset, durationInFrames, resolveAsset } = input;

  return {
    schemaVersion: TEMPLATE_DATA_SCHEMA_VERSION,
    track: {
      title: props.title,
      artist: props.artist,
      key: props.musicalKey,
      bpm: props.bpm,
      subtitle: props.subtitle ?? null,
    },
    assets: {
      cover: resolveAsset(props.coverSrc),
      audio: resolveAsset(props.audioSrc),
      waveformAudio: resolveAsset(props.waveformAudioSrc ?? props.audioSrc),
      brandLogo: resolveAsset(props.brandLogoSrc),
      brandBadge: resolveAsset(props.brandBadgeSrc),
    },
    format: {
      presetId: preset.id,
      width: preset.width,
      height: preset.height,
      fps: preset.fps,
      aspectRatio: preset.aspectRatio,
      layout: preset.layout,
    },
    timing: {
      fps: preset.fps,
      durationInFrames,
      durationInSeconds: durationInFrames / preset.fps,
    },
  };
};
