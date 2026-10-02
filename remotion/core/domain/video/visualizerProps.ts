import type { RenderPresetId } from "./renderPresets.ts";

/**
 * Everything a renderer needs to draw one track's visualizer video.
 *
 * This is the engine's render contract, owned by the core rather than by any
 * one renderer: the services build it (services/tracks/buildTrackProps.ts),
 * the API and CLI pass it around, and each render adapter consumes it. The
 * Remotion composition's props are this type, and a future adapter (a
 * Premiere Pro or After Effects template, say) maps the same fields onto its
 * own layers instead of inventing a second description of a track.
 */
export type VisualizerProps = {
  readonly title: string;
  readonly artist: string;
  readonly musicalKey: string;
  readonly bpm: number;
  readonly subtitle?: string;
  /** All *Src fields are paths relative to public/, e.g. "tracks/x/cover.png" */
  readonly coverSrc: string;
  readonly audioSrc: string;
  /** Lightweight audio used for the waveform only; falls back to audioSrc */
  readonly waveformAudioSrc?: string;
  readonly brandLogoSrc: string;
  readonly brandBadgeSrc: string;
  /**
   * Which export format to draw. Absent means the default (16:9), so props
   * written before presets existed still render exactly as they did.
   */
  readonly presetId?: RenderPresetId;
};
