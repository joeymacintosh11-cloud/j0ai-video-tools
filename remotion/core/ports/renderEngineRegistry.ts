import { TrackError, trackIssue } from "../domain/tracks/errors.ts";
import {
  assertRendererId,
  RENDERER_IDS,
  type RendererId,
  type RendererStatus,
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

/**
 * How an engine is registered: a lazy loader, optionally with a probe.
 *
 * An engine that depends on something outside this project (an installed
 * After Effects, say) supplies `probe`, which reports synchronously and
 * without loading the engine why it cannot run here, or null when it can.
 * It is asked every time availability is checked, so installing or
 * configuring the dependency takes effect without a restart.
 *
 * `configured` is separate on purpose: it reports, equally synchronously and
 * without loading the engine, whether the engine's local configuration is
 * usable (null when it is). It only feeds status() — so a UI can say "not
 * configured" before anyone renders — and never assertAvailable(), whose
 * answer to callers that name an engine is exactly what it always was: a
 * configuration problem still surfaces when the engine opens.
 */
export type RenderEngineRegistration =
  | (() => Promise<RenderEngine>)
  | {
      readonly load: () => Promise<RenderEngine>;
      readonly probe?: () => string | null;
      readonly configured?: () => string | null;
    };

export type RenderEngineLoaders = Partial<Record<RendererId, RenderEngineRegistration>>;

export type RenderEngineRegistry = {
  /** Renderer ids that can render right now, in RENDERER_IDS order. */
  readonly available: readonly RendererId[];
  /**
   * Validates a requested renderer without loading it: absent means the
   * default, an unknown id is INVALID_RENDERER, and a known id with no engine
   * registered, or whose probe reports a problem, is RENDERER_UNAVAILABLE.
   */
  readonly assertAvailable: (requested: unknown) => RendererId;
  /** assertAvailable(), then loads that engine. */
  readonly resolve: (requested: unknown) => Promise<RenderEngine>;
  /**
   * Every renderer id, in RENDERER_IDS order, with whether it can render here
   * and why not. Loads nothing; asks the probes afresh each time.
   */
  readonly status: () => readonly RendererStatus[];
};

export const createRenderEngineRegistry = (
  loaders: RenderEngineLoaders,
): RenderEngineRegistry => {
  const registration = (id: RendererId) => {
    const entry = loaders[id];
    if (entry === undefined) return null;
    return typeof entry === "function"
      ? { load: entry, probe: undefined, configured: undefined }
      : entry;
  };

  /** Null when the engine can run; otherwise why not (null reason = not registered). */
  const unavailable = (id: RendererId): { readonly reason: string | null } | null => {
    const entry = registration(id);
    if (entry === null) return { reason: null };
    const reason = entry.probe?.() ?? null;
    return reason === null ? null : { reason };
  };

  const availableNow = (): readonly RendererId[] =>
    RENDERER_IDS.filter((id) => unavailable(id) === null);

  const assertAvailable = (requested: unknown): RendererId => {
    const id = assertRendererId(requested);
    const problem = unavailable(id);

    if (problem !== null) {
      const others = availableNow();
      throw new TrackError(
        trackIssue(
          "RENDERER_UNAVAILABLE",
          problem.reason === null
            ? `The "${id}" render engine is not available in this installation. Available: ${others.join(", ") || "none"}.`
            : `The "${id}" render engine is not available: ${problem.reason} Available: ${others.join(", ") || "none"}.`,
        ),
      );
    }

    return id;
  };

  const status = (): readonly RendererStatus[] =>
    RENDERER_IDS.map((id): RendererStatus => {
      const entry = registration(id);
      if (entry === null) {
        return {
          id,
          implemented: false,
          state: "unavailable",
          problem: `The "${id}" render engine is not available in this installation.`,
        };
      }
      const missing = entry.probe?.() ?? null;
      if (missing !== null) {
        return { id, implemented: true, state: "unavailable", problem: missing };
      }
      const misconfigured = entry.configured?.() ?? null;
      return misconfigured === null
        ? { id, implemented: true, state: "ready", problem: null }
        : { id, implemented: true, state: "not_configured", problem: misconfigured };
    });

  return {
    get available() {
      return availableNow();
    },
    assertAvailable,
    status,
    resolve: async (requested) => {
      const id = assertAvailable(requested);
      const engine = await registration(id)!.load();

      // A registration mistake, not a user error: the table and the engine
      // disagree about what they are.
      if (engine.id !== id) {
        throw new Error(`Render engine registered as "${id}" reports id "${engine.id}".`);
      }

      return engine;
    },
  };
};
