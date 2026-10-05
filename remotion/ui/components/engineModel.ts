import type {
  RendererState,
  RendererStatus,
} from "../../core/domain/video/renderers.ts";
import type { RenderJobView } from "../../core/domain/api/views.ts";
import type { RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import {
  DEFAULT_RENDERER_ID,
  RENDERER_IDS,
  RENDERER_LABELS,
  resolveTrackRenderer,
  type RendererId,
} from "../../core/domain/video/renderers.ts";

/**
 * What the engine picker and the Render panel decide, kept free of React so it
 * can be tested directly — the same split as metadataSeed.ts.
 *
 * Availability always comes from GET /api/renderers; nothing here guesses it.
 */

/** "checking" until the server has said, so a slow request never reads as "unavailable". */
export type EngineOptionState = RendererState | "checking";

export type EngineOption = {
  readonly id: RendererId;
  readonly label: string;
  readonly state: EngineOptionState;
  readonly problem: string | null;
  /**
   * Whether picking it is allowed. An engine that cannot run here is shown
   * but not pickable — visibly unavailable rather than silently accepted —
   * except when it is already this track's choice, so a track is never stuck
   * displaying something it cannot change away from. Not configured is
   * pickable: choosing After Effects before its template is set up is a fair
   * intention, and the state says what is still missing.
   */
  readonly selectable: boolean;
};

/**
 * The engines to offer, in RENDERER_IDS order.
 *
 * Only implemented engines are offered (Premiere is reserved, not built), plus
 * the track's current choice whatever it is. Before availability has loaded,
 * the default and the current choice are shown as "checking".
 */
export const engineOptions = (
  statuses: readonly RendererStatus[] | null,
  current: RendererId,
): readonly EngineOption[] =>
  RENDERER_IDS.flatMap((id): EngineOption[] => {
    const status = statuses?.find((entry) => entry.id === id) ?? null;
    const isCurrent = id === current;

    if (status === null) {
      if (statuses !== null && !isCurrent) return [];
      if (statuses === null && !isCurrent && id !== DEFAULT_RENDERER_ID)
        return [];
      return [
        {
          id,
          label: RENDERER_LABELS[id],
          state: "checking",
          problem: null,
          selectable: true,
        },
      ];
    }

    if (!status.implemented && !isCurrent) return [];

    return [
      {
        id,
        label: RENDERER_LABELS[id],
        state: status.state,
        problem: status.problem,
        selectable: isCurrent || status.state !== "unavailable",
      },
    ];
  });

/** Short words for an engine's state, next to its name. Null when nothing needs saying. */
export const engineStateLabel = (state: EngineOptionState): string | null =>
  state === "unavailable"
    ? "not available"
    : state === "not_configured"
      ? "not configured"
      : state === "checking"
        ? "checking…"
        : null;

/** The engine a track's renders use from the app: its own saved preference. */
export const trackEngine = (track: {
  readonly renderer: RendererId | null;
}): RendererId => resolveTrackRenderer(track.renderer);

/** Reload and duplicate-request adoption must follow the selected renderer. */
export const activeRenderFor = (
  jobs: readonly RenderJobView[],
  slug: string,
  engine: RendererId,
  presetId?: RenderPresetId,
): RenderJobView | undefined =>
  jobs.find(
    (job) =>
      job.slug === slug &&
      job.engine === engine &&
      (presetId === undefined || job.presetId === presetId) &&
      ["queued", "preparing", "rendering"].includes(job.status),
  );

/**
 * Why the app must not start a render with this engine right now, or null.
 *
 * Not configured blocks too: the render would only fail a moment later with
 * the same message, after queuing. Unknown availability (still loading, or
 * the request failed) does not block — the server checks again when the
 * render is requested, and refuses an unavailable engine itself.
 */
export const renderBlockedReason = (
  engine: RendererId,
  statuses: readonly RendererStatus[] | null,
): string | null => {
  const status = statuses?.find((entry) => entry.id === engine);
  if (status === undefined || status.state === "ready") return null;
  const name = RENDERER_LABELS[engine];
  return status.state === "not_configured"
    ? `${name} is not configured: ${status.problem ?? "check its local settings."}`
    : `${name} is not available here: ${status.problem ?? "it is not installed."}`;
};
