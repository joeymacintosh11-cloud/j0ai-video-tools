/**
 * The one description of the video the visualizer produces.
 *
 * Pure and dependency-free, so the composition, the render services, the API
 * and any future <Player> preview all agree on id, size and frame rate
 * instead of repeating the numbers.
 */

export const COMPOSITION_ID = "ToshiBeatVisualizer";

export const FPS = 30;

export const COMPOSITION_CONFIG = {
  id: COMPOSITION_ID,
  width: 1920,
  height: 1080,
  fps: FPS,
} as const;

export const secondsToFrames = (seconds: number): number =>
  Math.ceil(seconds * FPS);
