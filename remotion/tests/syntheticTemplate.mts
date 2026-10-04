import { mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import type { TestContext } from "node:test";
import { readAfterEffectsConfig } from "../adapters/after-effects/afterEffectsConfig.mts";
import { afterEffectsTemplateIdentity } from "../adapters/after-effects/templateIdentity.mts";
import { fileContentHash } from "../services/tracks/exportManifest.ts";
import { registerTemplateIdentityReader } from "../services/render/templateIdentity.ts";

/** Existing workflow fixtures now explicitly name the template they rendered. */
export const syntheticTemplate = async (t: TestContext) => {
  const dir = await mkdtemp(path.join(tmpdir(), "workflow-template-"));
  const project = path.join(dir, "base.aep"), file = path.join(dir, "config.json");
  await writeFile(project, "RIFX synthetic workflow template");
  await writeFile(file, JSON.stringify({ project, composition: "Track template", templatePreparation: "auto" }));
  const config = readAfterEffectsConfig(file);
  const template = afterEffectsTemplateIdentity(config, "youtube-16x9", fileContentHash(project));
  const restore = registerTemplateIdentityReader("after-effects", () => ({ template, problem: null }));
  t.after(async () => { restore(); await rm(dir, { recursive: true, force: true }); });
  return template;
};
