import {
  DEFAULT_RENDER_PRESET_ID,
  renderPreset,
} from "./renderPresets.ts";

/**
 * The one description of the video the visualizer produces.
 *
 * Pure and dependency-free, so the composition, the render services, the API
 * and the <Player> preview all agree on id and frame rate instead of repeating
 * the numbers. Per-format width and height live in renderPresets.ts; the values
 * here describe the default format, which is what the Studio registers and
 * what a render with no preset named produces.
 */

export const COMPOSITION_ID = "ToshiBeatVisualizer";

const defaultPreset = renderPreset(DEFAULT_RENDER_PRESET_ID);

export const FPS = defaultPreset.fps;

export const COMPOSITION_CONFIG = {
  id: COMPOSITION_ID,
  width: defaultPreset.width,
  height: defaultPreset.height,
  fps: defaultPreset.fps,
} as const;

export const secondsToFrames = (seconds: number, fps: number = FPS): number =>
  Math.ceil(seconds * fps);
