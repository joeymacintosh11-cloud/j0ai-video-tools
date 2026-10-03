import type { ServerResponse } from "node:http";
import type { RenderersView } from "../../core/domain/api/views.ts";
import { DEFAULT_RENDERER_ID } from "../../core/domain/video/renderers.ts";
import { renderEngines } from "../../adapters/renderEngines.mts";
import { sendOk } from "../http/json.ts";

/**
 * Which renderers can render on this machine right now, and why not.
 *
 * Asked afresh on every request (the probes are cheap file checks), so
 * installing After Effects or fixing its configuration shows up without a
 * restart. Loads no engine. Read-only.
 */
export const handleListRenderers = (response: ServerResponse): void => {
  const payload: RenderersView = {
    defaultRenderer: DEFAULT_RENDERER_ID,
    renderers: renderEngines.status(),
  };

  sendOk(response, payload);
};
