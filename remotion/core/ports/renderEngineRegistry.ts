import { TrackError, trackIssue } from "../domain/tracks/errors.ts";
import {
  assertRendererId,
  RENDERER_IDS,
  type RendererId,
} from "../domain/video/renderers.ts";
import type { RenderEngine } from "./renderEngine.ts";

/**
 * Looks up a RenderEngine by renderer id.
 *
 * Callers never import a specific engine. They ask for one by id ("remotion",
 * or nothing for the default) and get either the engine or a clear error.
 * Engines are registered as loaders, so a host can check that a renderer
 * exists (to reject a bad API request up front, say) without loading that
 * renderer's dependencies; only resolve() loads one.
 *
 * Pure: the registry instance with real adapters in it lives in
 * adapters/renderEngines.mts.
 */

export type RenderEngineLoaders = Partial<Record<RendererId, () => Promise<RenderEngine>>>;

export type RenderEngineRegistry = {
  /** Renderer ids with an engine behind them, in RENDERER_IDS order. */
  readonly available: readonly RendererId[];
  /**
   * Validates a requested renderer without loading it: absent means the
   * default, an unknown id is INVALID_RENDERER, and a known id with no engine
   * registered is RENDERER_UNAVAILABLE.
   */
  readonly assertAvailable: (requested: unknown) => RendererId;
  /** assertAvailable(), then loads that engine. */
  readonly resolve: (requested: unknown) => Promise<RenderEngine>;
};

export const createRenderEngineRegistry = (
  loaders: RenderEngineLoaders,
): RenderEngineRegistry => {
  const available = RENDERER_IDS.filter((id) => loaders[id] !== undefined);

  const assertAvailable = (requested: unknown): RendererId => {
    const id = assertRendererId(requested);

    if (!available.includes(id)) {
      throw new TrackError(
        trackIssue(
          "RENDERER_UNAVAILABLE",
          `The "${id}" render engine is not available in this installation. Available: ${available.join(", ") || "none"}.`,
        ),
      );
    }

    return id;
  };

  return {
    available,
    assertAvailable,
    resolve: async (requested) => {
      const id = assertAvailable(requested);
      const engine = await loaders[id]!();

      // A registration mistake, not a user error: the table and the engine
      // disagree about what they are.
      if (engine.id !== id) {
        throw new Error(`Render engine registered as "${id}" reports id "${engine.id}".`);
      }

      return engine;
    },
  };
};
