import {
  DEFAULT_RENDERER_ID,
  resolveTrackRenderer,
  type RendererId,
} from "../../core/domain/video/renderers.ts";
import type { RenderPresetId } from "../../core/domain/video/renderPresets.ts";

/**
 * Request bodies that name a render engine, built in one place so the Render
 * panel, the batch it may start and the Reveal button all name it the same
 * way — and so the shape is testable without a browser.
 */

/**
 * The fields the app adds to a render request for this engine.
 *
 * Nothing for the default, so a track without a preference sends exactly the
 * request it always did; any other engine is named explicitly — the server
 * never infers it from the track, so API callers that name none still get
 * Remotion.
 */
export const engineField = (engine: RendererId): { readonly engine?: RendererId } =>
  engine === DEFAULT_RENDERER_ID ? {} : { engine };

/** POST /api/tracks/:slug/render body. */
export const startRenderBody = (
  preset: RenderPresetId | undefined,
  engine: RendererId,
): { readonly preset?: RenderPresetId; readonly engine?: RendererId } => ({
  ...(preset === undefined ? {} : { preset }),
  ...engineField(engine),
});

/** POST /api/render-batches targets for several formats of one track. */
export const batchTargets = (
  slug: string,
  presets: readonly RenderPresetId[],
  engine: RendererId,
): readonly { readonly slug: string; readonly preset: RenderPresetId; readonly engine?: RendererId }[] =>
  presets.map((preset) => ({ slug, preset, ...engineField(engine) }));

/**
 * The metadata patch that saves a track's engine choice on its own. The
 * default is stored as "no preference" (null), so choosing Remotion removes
 * the key and a track that never chose keeps a file without one.
 */
export const rendererPatch = (engine: RendererId): { readonly renderer: RendererId | null } => ({
  renderer: engine === DEFAULT_RENDERER_ID ? null : engine,
});

/** Read saved preferences immediately before catalogue queueing; a failed read
 * refuses the batch rather than inventing a default for an unread track. */
export const catalogueBatchTargets = async (
  slugs: readonly string[],
  presets: readonly RenderPresetId[],
  readTrack: (slug: string) => Promise<{ readonly renderer: RendererId | null }>,
): Promise<ReturnType<typeof batchTargets>> => {
  const tracks = await Promise.all(slugs.map(readTrack));
  return slugs.flatMap((slug, index) =>
    batchTargets(slug, presets, resolveTrackRenderer(tracks[index].renderer)),
  );
};
