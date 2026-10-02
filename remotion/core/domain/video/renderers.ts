import { TrackError, trackIssue } from "../tracks/errors.ts";

/**
 * The renderers a render job can name, defined once.
 *
 * An id here is a *name*, not an implementation: which of them can actually
 * render on this machine is decided by the adapters that are registered
 * (adapters/renderEngines.mts). Today only "remotion" has one. The others are
 * reserved so that jobs, journals and library records can already carry them,
 * and so that asking for one fails with "not available" rather than "unknown".
 */

export const RENDERER_IDS = ["remotion", "premiere", "after-effects"] as const;

export type RendererId = (typeof RENDERER_IDS)[number];

/**
 * What every job, command and record means when no renderer is named. Every
 * render made before renderers were selectable was a Remotion render.
 */
export const DEFAULT_RENDERER_ID: RendererId = "remotion";

export const isRendererId = (value: unknown): value is RendererId =>
  typeof value === "string" && (RENDERER_IDS as readonly string[]).includes(value);

/** Resolves a renderer id from untrusted input, defaulting when absent. */
export const assertRendererId = (value: unknown): RendererId => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_RENDERER_ID;
  }

  if (!isRendererId(value)) {
    throw new TrackError(
      trackIssue(
        "INVALID_RENDERER",
        `Unknown render engine ${JSON.stringify(value)}. Expected one of: ${RENDERER_IDS.join(", ")}.`,
      ),
    );
  }

  return value;
};

/**
 * A stored renderer id read back leniently: anything written before renderers
 * were recorded (no field) was Remotion. An unrecognised value is kept as
 * `null` rather than guessed.
 */
export const storedRendererId = (value: unknown): RendererId | null =>
  value === undefined ? DEFAULT_RENDERER_ID : isRendererId(value) ? value : null;
