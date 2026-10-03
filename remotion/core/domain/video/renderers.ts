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

/**
 * Whether a renderer can render on this machine right now.
 *
 * - ready:          installed and configured
 * - unavailable:    not implemented in this installation, or its software is
 *                   not installed — asking it to render is refused up front
 * - not_configured: installed, but its local configuration (an After Effects
 *                   template, say) is missing or wrong — a render would fail
 *                   when the engine opens, with the same message
 */
export type RendererState = "ready" | "unavailable" | "not_configured";

export type RendererStatus = {
  readonly id: RendererId;
  /** An adapter is registered for it. Reserved ids (premiere) are not. */
  readonly implemented: boolean;
  readonly state: RendererState;
  /** Why it is not ready, in words for the person on this machine; null when ready. */
  readonly problem: string | null;
};

/** How each renderer is named to a person, in the UI and in messages. */
export const RENDERER_LABELS: Record<RendererId, string> = {
  remotion: "Remotion",
  premiere: "Premiere Pro",
  "after-effects": "After Effects",
};

export const isRendererId = (value: unknown): value is RendererId =>
  typeof value === "string" && (RENDERER_IDS as readonly string[]).includes(value);

/**
 * The renderer a track's own preference (metadata.json "renderer") resolves
 * to. Undeclared is the default, which is what every track was before a
 * preference could be stored, so nothing has to be migrated.
 */
export const resolveTrackRenderer = (
  declared: RendererId | null | undefined,
): RendererId => declared ?? DEFAULT_RENDERER_ID;

/**
 * Checks a declared "renderer" field: absent is undeclared, and anything
 * declared must be a known renderer id. Whether that renderer is installed is
 * deliberately not judged here — metadata.json is portable, and installation
 * is a fact about one machine, checked when a render is requested.
 */
export const parseTrackRenderer = (
  raw: unknown,
): { readonly renderer: RendererId | undefined; readonly problem: string | null } => {
  if (raw === undefined) return { renderer: undefined, problem: null };
  if (isRendererId(raw)) return { renderer: raw, problem: null };
  return {
    renderer: undefined,
    problem: `field "renderer" must be one of ${RENDERER_IDS.join(", ")} when present, or left out to use ${DEFAULT_RENDERER_ID}.`,
  };
};

/**
 * Why a Remotion-only pipeline leaves a track out, or null when it doesn't.
 *
 * Coverage, delivery, release bundles, content packages and their planners
 * judge Remotion's exports (out/<slug>/<preset>.mp4) only. For a track that
 * prefers another renderer, acting on those exports would let a Remotion video
 * stand in for the one the track asked for, so each of them leaves the track
 * out and says so with this one message, rather than silently falling back.
 */
export const remotionOnlyProblem = (
  renderer: RendererId,
  operation: string,
): string | null =>
  renderer === DEFAULT_RENDERER_ID
    ? null
    : `This track prefers ${RENDERER_LABELS[renderer]}; ${operation} works with ${RENDERER_LABELS[DEFAULT_RENDERER_ID]} exports only, so it is left out. ` +
      `Render it with ${RENDERER_LABELS[renderer]} from the track's Render panel (under Advanced), or with render-track --engine ${renderer}.`;

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

/**
 * What a renderer adds to an export's visualizer fingerprint
 * (services/tracks/exportManifest.ts), so that exports drawn by different
 * renderers are never mistaken for one another: an export is current only for
 * the renderer whose fingerprint it carries.
 *
 * Remotion adds nothing. Every manifest written before renderers were
 * selectable is a Remotion export fingerprinted without this part, so keeping
 * Remotion's contribution empty is what keeps all of those exports current.
 */
export const rendererFingerprintParts = (renderer: RendererId): readonly string[] =>
  renderer === "remotion" ? [] : [`renderer:${renderer}`];
