import { createRenderEngineRegistry } from "../core/ports/renderEngineRegistry.ts";
import {
  describeAerenderNotFound,
  discoverInstalledAerender,
} from "./after-effects/aerenderDiscovery.mts";
import { readAfterEffectsConfig } from "./after-effects/afterEffectsConfig.mts";

/**
 * Every render engine this installation has, by renderer id.
 *
 * The one place that knows which adapter implements which renderer. Entry
 * points (the CLI scripts and the render worker) resolve an engine here by
 * id; the API server uses it to reject an unavailable renderer before queuing
 * a job. Engines load lazily, so importing this module does not load Remotion.
 *
 * An engine that depends on software outside this project also registers a
 * probe, asked on every availability check, so "is it installed?" is answered
 * without loading the engine and without a restart after installing it.
 *
 * A future adapter registers itself the same way, e.g.
 *   premiere: async () => (await import("./premiere/premiereRenderEngine.mts")).premiereRenderEngine,
 */
export const renderEngines = createRenderEngineRegistry({
  remotion: async () =>
    (await import("./remotion/remotionRenderEngine.mts")).remotionRenderEngine,
  "after-effects": {
    load: async () =>
      (await import("./after-effects/afterEffectsRenderEngine.mts")).afterEffectsRenderEngine,
    // Installed? Whether it is also configured is checked when a render opens
    // the engine, so that error can say exactly what to put in the config.
    probe: () => {
      const discovery = discoverInstalledAerender();
      return discovery.found ? null : describeAerenderNotFound(discovery);
    },
    // Only for reporting status (a UI's "not configured"): the same reader the
    // engine opens with, so the message is the one a render would fail with.
    configured: () => {
      try {
        readAfterEffectsConfig();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  },
});
