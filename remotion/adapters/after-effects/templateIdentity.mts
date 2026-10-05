import type { RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import type { RenderTemplateIdentity } from "../../core/ports/renderEngine.ts";
import type { TemplateIdentityState } from "../../core/ports/templateIdentity.ts";
import { fileContentHash } from "../../services/tracks/exportManifest.ts";
import { afterEffectsComposition, readAfterEffectsConfig, type AfterEffectsConfig } from "./afterEffectsConfig.mts";
import { PREPARATION_VERSION } from "./afterEffectsScripting.mts";

/** Canonical base identity, never a generated project's hash or track marker. */
export const afterEffectsTemplateIdentity = (
  config: AfterEffectsConfig,
  presetId: RenderPresetId,
  baseHash: string,
  prepVersion = PREPARATION_VERSION,
): RenderTemplateIdentity => ({
  composition: afterEffectsComposition(config, presetId),
  version: `aep-sha256:${baseHash};prep:${prepVersion};mode:${config.templatePreparation}`,
});

/** Hash/stat only; no Adobe installation, preparation cache or GUI required. */
export const readAfterEffectsTemplateIdentity = (presetId: RenderPresetId): TemplateIdentityState => {
  try {
    const config = readAfterEffectsConfig();
    return { template: afterEffectsTemplateIdentity(config, presetId, fileContentHash(config.project)), problem: null };
  } catch (error) {
    return { template: null, problem: error instanceof Error ? error.message : String(error) };
  }
};
