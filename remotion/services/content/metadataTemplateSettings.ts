import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
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
  /** Hash of the exact file bytes, or "missing" if no file exists. */
  readonly revision: string;
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
  async (filePath = CONTENT_METADATA_SETTINGS_FILE): Promise<ReadContentMetadataSettingsResult> => {
    let raw: string;
    try {
      raw = await readFile(filePath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        return { settings: EMPTY_CONTENT_METADATA_SETTINGS, revision: "missing", problem: null };
      }
      return {
        settings: EMPTY_CONTENT_METADATA_SETTINGS,
        revision: "unreadable",
        problem: `${filePath} could not be read: ${
          error instanceof Error ? error.message : String(error)
        }. Using built-in defaults until it is fixed.`,
      };
    }

    const revision = createHash("sha256").update(raw).digest("hex");

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return {
        settings: EMPTY_CONTENT_METADATA_SETTINGS,
        revision,
        problem: `${filePath} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }. Using built-in defaults until it is fixed.`,
      };
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { settings: EMPTY_CONTENT_METADATA_SETTINGS, revision,
        problem: `${filePath} must contain a settings object. Using built-in defaults until it is fixed.` };
    }
    const record = parsed as Record<string, unknown>;
    const shapeProblems: string[] = [];
    if (record.schemaVersion !== CONTENT_METADATA_TEMPLATES_SCHEMA_VERSION) {
      shapeProblems.push(`schemaVersion must be ${CONTENT_METADATA_TEMPLATES_SCHEMA_VERSION}.`);
    }
    if (record.templates === undefined || record.templates === null) {
      shapeProblems.push("templates must be an object.");
    }
    for (const key of Object.keys(record)) {
      if (key !== "schemaVersion" && key !== "templates") shapeProblems.push(`Unknown settings key "${key}".`);
    }
    const { templates, problems } = parseMetadataTemplates(
      record.templates,
      "templates",
    );

    if (shapeProblems.length > 0 || problems.length > 0) {
      return {
        settings: EMPTY_CONTENT_METADATA_SETTINGS,
        revision,
        problem: `${filePath} is malformed: ${[...shapeProblems, ...problems].join(" ")} Using built-in defaults until it is fixed.`,
      };
    }

    return {
      settings: {
        schemaVersion: CONTENT_METADATA_TEMPLATES_SCHEMA_VERSION,
        templates: templates ?? {},
      },
      revision,
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
  expectedRevision?: string,
  filePath = CONTENT_METADATA_SETTINGS_FILE,
): Promise<{ settings: ContentMetadataSettingsStored; revision: string }> =>
  withFileMutation(filePath, async () => {
    const { patch, problems: patchProblems } = parseMetadataTemplatesResetPatch(
      rawPatch,
      "templates",
    );
    assertNoTemplateProblems(patchProblems);

    const { settings: current, problem, revision } = await readContentMetadataSettings(filePath);
    if (problem !== null) {
      assertNoTemplateProblems([
        `${filePath} is currently unreadable and must be fixed or removed by hand before it can be edited here: ${problem}`,
      ]);
    }
    const conflict = () => new TrackError(trackIssue("TEMPLATE_CONFLICT", "Content metadata settings changed since they were read. Refresh before saving again."));
    if (expectedRevision !== undefined && expectedRevision !== revision) throw conflict();

    const next: ContentMetadataSettingsStored = {
      schemaVersion: CONTENT_METADATA_TEMPLATES_SCHEMA_VERSION,
      templates: applyMetadataTemplatesResetPatch(
        current.templates,
        (patch ?? {}) as MetadataTemplatesResetPatch,
      ),
    };

    const serialized = `${JSON.stringify(next, null, 2)}\n`;
    await writeAtomicFile(filePath, (handle) =>
      handle.writeFile(serialized, "utf-8"),
      async () => {
        const latest = await readContentMetadataSettings(filePath);
        if (latest.problem !== null || latest.revision !== revision) throw conflict();
      },
    );

    return { settings: next, revision: createHash("sha256").update(serialized).digest("hex") };
  });
