import { useEffect, useState } from "react";
import type { RenderersView } from "../../core/domain/api/views.ts";
import { listRenderers } from "../api/client.ts";

/**
 * Which render engines can run on this machine, from GET /api/renderers.
 *
 * Re-asked whenever `key` changes (the selected track, or its metadata
 * revision after a save), so installing or configuring After Effects shows up
 * without reloading the page. Null while loading or if the request failed:
 * callers then show "checking" rather than guessing, and the server still
 * refuses an unavailable engine when a render is requested.
 */
export const useRenderers = (key: string): RenderersView | null => {
  const [renderers, setRenderers] = useState<RenderersView | null>(null);

  useEffect(() => {
    let abandoned = false;

    void listRenderers()
      .then((view) => {
        if (!abandoned) setRenderers(view);
      })
      .catch(() => {
        if (!abandoned) setRenderers(null);
      });

    return () => {
      abandoned = true;
    };
  }, [key]);

  return renderers;
};
