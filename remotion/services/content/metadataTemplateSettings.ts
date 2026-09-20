import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  applyMetadataTemplatesResetPatch,
  assertNoTemplateProblems,
  CONTENT_METADATA_TEMPLATES_SCHEMA_VERSION,
  parseMetadataTemplates,
  parseMetadataTemplatesResetPatch,
  type MetadataTemplatesResetPatch,
  type PartialMetadataTemplates,
} from "../../src/domain/content/metadataTemplates.ts";
import { PROJECT_ROOT } from "../tracks/trackLocations.ts";
import { withFileMutation, writeAtomicFile } from "../tracks/atomicFile.ts";

/**
 * Global content-metadata template overrides, local to this machine.
 *
 * Mirrors delivery.local.json exactly (services/delivery/deliverySettings.ts):
 * a gitignored JSON file at the project root, read/write through the same
 * atomic-write helper, absent-means-nothing-configured. Kept local rather
 * than committed because it is machine/person-specific customization of
 * generated copy, the same category as `autoDeliver` — the built-in defaults
 * already ship in code and are what every fresh clone of this repo starts
 * from.
 */

export const CONTENT_METADATA_SETTINGS_FILE = path.join(
  PROJECT_ROOT,
  "content-metadata.local.json",
);

export type ContentMetadataSettingsStored = {
  readonly schemaVersion: number;
  /** Only the fields actually overridden; everything else inherits the built-in default. */
  readonly templates: PartialMetadataTemplates;
};

export const EMPTY_CONTENT_METADATA_SETTINGS: ContentMetadataSettingsStored = {
  schemaVersion: CONTENT_METADATA_TEMPLATES_SCHEMA_VERSION,
  templates: {},
};

export type ReadContentMetadataSettingsResult = {
  readonly settings: ContentMetadataSettingsStored;
  /**
   * Set only when the file exists but could not be read as valid settings —
   * never for a simply-absent file, which just means "nothing configured
   * yet". Built-in defaults are used either way; this is what keeps that
   * corruption visible instead of silently swallowed (handoff, "Invalid
   * template recovery").
   */
  readonly problem: string | null;
};

/**
 * Current global template overrides, or empty with a `problem` explaining why
 * if the file could not be read. Never throws: a broken local config must not
 * stop the app from rendering or generating package copy — but it must not
 * pretend nothing is wrong either.
 */
export const readContentMetadataSettings =
  async (): Promise<ReadContentMetadataSettingsResult> => {
    let raw: string;
    try {
      raw = await readFile(CONTENT_METADATA_SETTINGS_FILE, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { settings: EMPTY_CONTENT_METADATA_SETTINGS, problem: null };
      }
      return {
        settings: EMPTY_CONTENT_METADATA_SETTINGS,
        problem: `${CONTENT_METADATA_SETTINGS_FILE} could not be read: ${
          error instanceof Error ? error.message : String(error)
        }. Using built-in defaults until it is fixed.`,
      };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        settings: EMPTY_CONTENT_METADATA_SETTINGS,
        problem: `${CONTENT_METADATA_SETTINGS_FILE} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }. Using built-in defaults until it is fixed.`,
      };
    }

    const record = parsed as Record<string, unknown>;
    const { templates, problems } = parseMetadataTemplates(
      record.templates,
      "templates",
    );

    if (problems.length > 0) {
      return {
        settings: EMPTY_CONTENT_METADATA_SETTINGS,
        problem: `${CONTENT_METADATA_SETTINGS_FILE} is malformed: ${problems.join(" ")} Using built-in defaults until it is fixed.`,
      };
    }

    return {
      settings: {
        schemaVersion: CONTENT_METADATA_TEMPLATES_SCHEMA_VERSION,
        templates: templates ?? {},
      },
      problem: null,
    };
  };

/**
 * Applies a field-by-field reset patch (string sets, null resets to
 * built-in, omitted leaves alone) and writes atomically.
 *
 * Deliberately does not start from a settings read that returned a
 * `problem`: writing on top of a file we know we could not parse would
 * silently discard whatever was actually there. A corrupt file must be fixed
 * or removed by hand before it can be edited through this path — surfaced to
 * the caller as the same TEMPLATE_INVALID a bad template would produce.
 */
export const writeContentMetadataSettingsPatch = async (
  rawPatch: unknown,
): Promise<ContentMetadataSettingsStored> =>
  withFileMutation(CONTENT_METADATA_SETTINGS_FILE, async () => {
    const { patch, problems: patchProblems } = parseMetadataTemplatesResetPatch(
      rawPatch,
      "templates",
    );
    assertNoTemplateProblems(patchProblems);

    const { settings: current, problem } = await readContentMetadataSettings();
    if (problem !== null) {
      assertNoTemplateProblems([
        `${CONTENT_METADATA_SETTINGS_FILE} is currently unreadable and must be fixed or removed by hand before it can be edited here: ${problem}`,
      ]);
    }

    const next: ContentMetadataSettingsStored = {
      schemaVersion: CONTENT_METADATA_TEMPLATES_SCHEMA_VERSION,
      templates: applyMetadataTemplatesResetPatch(
        current.templates,
        (patch ?? {}) as MetadataTemplatesResetPatch,
      ),
    };

    await writeAtomicFile(CONTENT_METADATA_SETTINGS_FILE, (handle) =>
      handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf-8"),
    );

    return next;
  });
