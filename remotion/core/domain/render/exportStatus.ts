import type { RenderPresetId } from "../video/renderPresets.ts";
import type { RendererId } from "../video/renderers.ts";

/** Identifies whose export a queued/running job is making. Locks still use
 * track/format pairs, independently of this engine-specific display key. */
export const exportStatusKey = (
  slug: string,
  presetId: RenderPresetId,
  renderer: RendererId,
): string => `${slug}::${presetId}::${renderer}`;
