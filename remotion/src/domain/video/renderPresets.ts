import { TrackError, trackIssue } from "../tracks/errors.ts";

/**
 * The export formats the visualizer can render, defined once.
 *
 * Pure and dependency-free, so the composition, the render service, the API,
 * the CLI and the UI all read the same numbers instead of repeating them. A new
 * format is added here and everywhere else picks it up.
 *
 * `layout` is the only thing the composition branches on. It is deliberately a
 * small set of shapes rather than one per preset, so two presets with the same
 * proportions share a layout instead of growing a second implementation.
 */

export type RenderLayout = "landscape" | "portrait" | "square";

export const RENDER_PRESET_IDS = [
  "youtube-16x9",
  "vertical-9x16",
  "square-1x1",
] as const;

export type RenderPresetId = (typeof RENDER_PRESET_IDS)[number];

export type RenderPreset = {
  readonly id: RenderPresetId;
  readonly label: string;
  /** Short form for compact UI, e.g. a checkbox row. */
  readonly shortLabel: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly aspectRatio: string;
  readonly layout: RenderLayout;
};

export const RENDER_PRESETS: Record<RenderPresetId, RenderPreset> = {
  "youtube-16x9": {
    id: "youtube-16x9",
    label: "YouTube Landscape",
    shortLabel: "YouTube 16:9",
    width: 1920,
    height: 1080,
    fps: 30,
    aspectRatio: "16:9",
    layout: "landscape",
  },
  "vertical-9x16": {
    id: "vertical-9x16",
    label: "Reels / Shorts",
    shortLabel: "Reels 9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    aspectRatio: "9:16",
    layout: "portrait",
  },
  "square-1x1": {
    id: "square-1x1",
    label: "Square",
    shortLabel: "Square 1:1",
    width: 1080,
    height: 1080,
    fps: 30,
    aspectRatio: "1:1",
    layout: "square",
  },
};

/**
 * The format everything defaults to when none is named.
 *
 * This is what `render-track` produced before presets existed, so leaving it
 * unspecified keeps the original behaviour.
 */
export const DEFAULT_RENDER_PRESET_ID: RenderPresetId = "youtube-16x9";

export const RENDER_PRESET_LIST: readonly RenderPreset[] =
  RENDER_PRESET_IDS.map((id) => RENDER_PRESETS[id]);

export const isRenderPresetId = (value: unknown): value is RenderPresetId =>
  typeof value === "string" &&
  (RENDER_PRESET_IDS as readonly string[]).includes(value);

export const renderPreset = (id: RenderPresetId): RenderPreset =>
  RENDER_PRESETS[id];

/** Resolves a preset id from untrusted input, defaulting when absent. */
export const assertRenderPresetId = (value: unknown): RenderPresetId => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_RENDER_PRESET_ID;
  }

  if (!isRenderPresetId(value)) {
    throw new TrackError(
      trackIssue(
        "INVALID_PRESET",
        `Unknown render preset ${JSON.stringify(value)}. Expected one of: ${RENDER_PRESET_IDS.join(", ")}.`,
      ),
    );
  }

  return value;
};
