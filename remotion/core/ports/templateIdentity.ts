import type { RenderPresetId } from "../domain/video/renderPresets.ts";
import type { RenderTemplateIdentity } from "./renderEngine.ts";

/** Observation only: must not launch a renderer or prepare a working copy. */
export type TemplateIdentityState =
  | { readonly template: RenderTemplateIdentity; readonly problem: null }
  | { readonly template: null; readonly problem: string };
export type TemplateIdentityReader = (presetId: RenderPresetId) => TemplateIdentityState;
