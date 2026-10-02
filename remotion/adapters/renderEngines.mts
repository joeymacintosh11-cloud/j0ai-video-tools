import { createRenderEngineRegistry } from "../core/ports/renderEngineRegistry.ts";

/**
 * Every render engine this installation has, by renderer id.
 *
 * The one place that knows which adapter implements which renderer. Entry
 * points (the CLI scripts and the render worker) resolve an engine here by
 * id; the API server uses it to reject an unavailable renderer before queuing
 * a job. Engines load lazily, so importing this module does not load Remotion.
 *
 * A future adapter registers itself with one line, e.g.
 *   premiere: async () => (await import("./premiere/premiereRenderEngine.mts")).premiereRenderEngine,
 */
export const renderEngines = createRenderEngineRegistry({
  remotion: async () =>
    (await import("./remotion/remotionRenderEngine.mts")).remotionRenderEngine,
});
