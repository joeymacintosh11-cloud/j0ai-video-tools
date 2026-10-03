import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { isRenderPresetId, type RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import { TEMPLATE_DATA_FILE_NAME } from "./templateContract.mts";

/**
 * Which After Effects project renders Toshi videos, and how.
 *
 * Read from after-effects.local.json at the project root (machine-local and
 * git-ignored, like delivery.local.json), or from the file TOSHI_AE_CONFIG
 * names. Relative paths in it are relative to the file itself.
 *
 *   {
 *     "project": "/Users/me/Toshi/ToshiVisualizer.aep",
 *     "composition": "Toshi Visualizer",
 *     "compositions": { "vertical-9x16": "Toshi Visualizer 9x16" },
 *     "outputModule": "H.264 - Match Render Settings - 15 Mbps",
 *     "dataFile": "/Users/me/Toshi/toshi-render-data.json",
 *     "aerenderPath": "/Applications/Adobe After Effects 2025/aerender",
 *     "templateCheck": true
 *   }
 *
 * Only "project" and "composition" are required. Anything wrong is a
 * RENDERER_NOT_CONFIGURED error that says what to change.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const AFTER_EFFECTS_CONFIG_FILE = path.join(PROJECT_ROOT, "after-effects.local.json");
export const AFTER_EFFECTS_CONFIG_ENV = "TOSHI_AE_CONFIG";

export type AfterEffectsConfig = {
  /** Absolute path of the .aep/.aepx project. */
  readonly project: string;
  /** The composition to render when the format has no entry in `compositions`. */
  readonly composition: string;
  /** Per-format compositions, e.g. a 9:16 comp for vertical-9x16. */
  readonly compositions: Partial<Record<RenderPresetId, string>>;
  /** An output-module template name in that After Effects; null uses the project's. */
  readonly outputModule: string | null;
  /** Where the template-data sidecar is written; the project imports this file. */
  readonly dataFile: string;
  readonly aerenderPath: string | null;
  /**
   * Whether to refuse a project that never mentions the staged data, cover
   * and audio files (templateContract.mts). On unless set to false.
   */
  readonly templateCheck: boolean;
};

export const afterEffectsConfigFile = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => env[AFTER_EFFECTS_CONFIG_ENV] || AFTER_EFFECTS_CONFIG_FILE;

const EXAMPLE = `{"project": "/path/to/ToshiVisualizer.aep", "composition": "Toshi Visualizer"}`;

const notConfigured = (message: string): TrackError =>
  new TrackError(trackIssue("RENDERER_NOT_CONFIGURED", message));

const readJson = (file: string): unknown => {
  if (!existsSync(file)) {
    throw notConfigured(
      `After Effects rendering needs a template, and there is no ${path.basename(file)}. ` +
        `Create ${file} with at least ${EXAMPLE} (see the README's "Rendering with After Effects").`,
    );
  }
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw notConfigured(`${file} is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`);
  }
};

/** The aerenderPath setting alone, leniently: used by the availability probe, which must never throw. */
export const readConfiguredAerenderPath = (file: string = afterEffectsConfigFile()): string | null => {
  try {
    const value = (JSON.parse(readFileSync(file, "utf8")) as { aerenderPath?: unknown }).aerenderPath;
    return typeof value === "string" && value !== "" ? path.resolve(path.dirname(file), value) : null;
  } catch {
    return null;
  }
};

export const readAfterEffectsConfig = (file: string = afterEffectsConfigFile()): AfterEffectsConfig => {
  const raw = readJson(file);
  const where = path.basename(file);

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw notConfigured(`${where} must be a JSON object like ${EXAMPLE}.`);
  }
  const value = raw as Record<string, unknown>;
  const resolve = (entry: string) => path.resolve(path.dirname(file), entry);

  if (typeof value.project !== "string" || value.project === "") {
    throw notConfigured(`${where} needs "project": the path of your After Effects .aep template.`);
  }
  const project = resolve(value.project);
  if (!/\.aepx?$/i.test(project)) {
    throw notConfigured(`${where} "project" must be an After Effects project (.aep or .aepx); got ${project}.`);
  }
  if (!existsSync(project) || !statSync(project).isFile()) {
    throw notConfigured(`${where} "project" points to ${project}, which does not exist.`);
  }

  if (typeof value.composition !== "string" || value.composition.trim() === "") {
    throw notConfigured(`${where} needs "composition": the name of the composition in ${path.basename(project)} to render.`);
  }

  const compositions: Partial<Record<RenderPresetId, string>> = {};
  if (value.compositions !== undefined) {
    if (typeof value.compositions !== "object" || value.compositions === null || Array.isArray(value.compositions)) {
      throw notConfigured(`${where} "compositions" must map format ids to composition names.`);
    }
    for (const [presetId, name] of Object.entries(value.compositions)) {
      if (!isRenderPresetId(presetId)) {
        throw notConfigured(`${where} "compositions" has an unknown format "${presetId}".`);
      }
      if (typeof name !== "string" || name.trim() === "") {
        throw notConfigured(`${where} "compositions"."${presetId}" must be a composition name.`);
      }
      compositions[presetId] = name;
    }
  }

  if (value.templateCheck !== undefined && typeof value.templateCheck !== "boolean") {
    throw notConfigured(`${where} "templateCheck" must be true or false.`);
  }

  for (const key of ["outputModule", "dataFile", "aerenderPath"] as const) {
    if (value[key] !== undefined && (typeof value[key] !== "string" || value[key] === "")) {
      throw notConfigured(`${where} "${key}" must be a non-empty string when present.`);
    }
  }

  return {
    project,
    composition: value.composition,
    compositions,
    outputModule: (value.outputModule as string | undefined) ?? null,
    dataFile:
      value.dataFile === undefined
        ? path.join(path.dirname(project), TEMPLATE_DATA_FILE_NAME)
        : resolve(value.dataFile as string),
    aerenderPath: value.aerenderPath === undefined ? null : resolve(value.aerenderPath as string),
    templateCheck: value.templateCheck !== false,
  };
};
