import type { RendererId } from "../../core/domain/video/renderers.ts";
import type { RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import type { TemplateIdentityReader, TemplateIdentityState } from "../../core/ports/templateIdentity.ts";

// Hosts wire observations through the adapter registry, just as they wire
// rendering. The runtime never imports an adapter or guesses a template.
const readers = new Map<RendererId, TemplateIdentityReader>();
export const registerTemplateIdentityReader = (renderer: RendererId, reader: TemplateIdentityReader): (() => void) => {
  const previous = readers.get(renderer);
  readers.set(renderer, reader);
  return () => {
    if (previous) readers.set(renderer, previous);
    else readers.delete(renderer);
  };
};

export const currentTemplateIdentity = (renderer: RendererId, presetId: RenderPresetId): TemplateIdentityState => {
  try {
    return readers.get(renderer)?.(presetId) ?? { template: null, problem: "Template identity reader unavailable." };
  } catch (error) {
    return { template: null, problem: error instanceof Error ? error.message : String(error) };
  }
};
