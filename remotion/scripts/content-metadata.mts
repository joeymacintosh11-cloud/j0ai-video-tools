import {
  resolveMetadataTemplates,
  type MetadataTemplatesResetPatch,
} from "../core/domain/content/metadataTemplates.ts";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import {
  CONTENT_METADATA_SETTINGS_FILE,
  readContentMetadataSettings,
  writeContentMetadataSettingsPatch,
} from "../services/content/metadataTemplateSettings.ts";
import { runCli } from "./cli.ts";

/**
 * Inspects and edits the global content-metadata templates — the layer
 * between a track's own overrides and the built-in defaults.
 *
 * No interactive editor: flag-based, like every other script here. The app's
 * Content Metadata settings panel is the primary editing surface; this is
 * for inspection and quick one-line changes from the terminal.
 */

const FIELD_PATH_HELP =
  "<platform>.<field>, e.g. youtube.titleTemplate, reels.captionTemplate, " +
  "instagram-square.hashtagsTemplate";

const printUsage = () => {
  console.error(
    [
      "Usage: npm run content-metadata -- --show",
      "       npm run content-metadata -- --set <field> \"<template>\"",
      "       npm run content-metadata -- --reset <field>",
      "       npm run content-metadata -- --reset-all",
      "",
      `  <field>       ${FIELD_PATH_HELP}`,
      "  --show        Print built-in, global override and resolved templates (default)",
      "  --set         Set one global template field, validated before saving",
      "  --reset       Clear one global field back to its built-in default",
      "  --reset-all   Clear every global override back to built-in defaults",
      "",
      "Examples:",
      '  npm run content-metadata -- --set youtube.titleTemplate "{title} | {artist}"',
      "  npm run content-metadata -- --reset youtube.titleTemplate",
      "  npm run content-metadata -- --show",
    ].join("\n"),
  );
};

const parseFieldPath = (path: string): { platform: string; field: string } => {
  const dot = path.indexOf(".");
  if (dot === -1) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", `Expected ${FIELD_PATH_HELP}, got "${path}".`),
    );
  }
  return { platform: path.slice(0, dot), field: path.slice(dot + 1) };
};

const patchFor = (
  path: string,
  value: string | null,
): MetadataTemplatesResetPatch => {
  const { platform, field } = parseFieldPath(path);
  return { [platform]: { [field]: value } } as MetadataTemplatesResetPatch;
};

const showTemplates = async (): Promise<void> => {
  const { settings, problem } = await readContentMetadataSettings();

  if (problem) {
    throw new TrackError(trackIssue("TEMPLATE_INVALID", problem));
  }

  console.log(`Settings file: ${CONTENT_METADATA_SETTINGS_FILE}\n`);

  const resolved = resolveMetadataTemplates(settings.templates, null);

  for (const platform of ["youtube", "reels", "instagram-square"] as const) {
    console.log(platform);
    const fields = Object.entries(resolved[platform]) as [string, string][];
    for (const [field, value] of fields) {
      const overridden =
        (settings.templates[platform] as Record<string, string> | undefined)?.[field] !==
        undefined;
      console.log(`  ${field}${overridden ? " (global override)" : " (built-in)"}:`);
      console.log(
        value
          .split("\n")
          .map((line) => `    ${line}`)
          .join("\n"),
      );
    }
  }
};

runCli("inspecting content metadata settings", async () => {
  const argv = process.argv.slice(2);

  if (argv.includes("--reset-all")) {
    const current = await readContentMetadataSettings();
    const patch: MetadataTemplatesResetPatch = {};
    for (const platform of Object.keys(current.settings.templates) as (keyof MetadataTemplatesResetPatch)[]) {
      const fields = current.settings.templates[platform];
      if (!fields) continue;
      (patch as Record<string, Record<string, null>>)[platform] = Object.fromEntries(
        Object.keys(fields).map((field) => [field, null]),
      );
    }
    await writeContentMetadataSettingsPatch(patch);
    console.log("✓ Every global template reset to its built-in default.");
    return;
  }

  const resetIndex = argv.indexOf("--reset");
  if (resetIndex !== -1) {
    const path = argv[resetIndex + 1];
    if (!path) {
      printUsage();
      process.exit(1);
    }
    await writeContentMetadataSettingsPatch(patchFor(path, null));
    console.log(`✓ ${path} reset to built-in default.`);
    return;
  }

  const setIndex = argv.indexOf("--set");
  if (setIndex !== -1) {
    const path = argv[setIndex + 1];
    const value = argv[setIndex + 2];
    if (!path || value === undefined) {
      printUsage();
      process.exit(1);
    }
    await writeContentMetadataSettingsPatch(patchFor(path, value));
    console.log(`✓ ${path} updated.`);
    return;
  }

  if (argv.length > 0 && (argv.length !== 1 || argv[0] !== "--show")) {
    printUsage();
    throw new TrackError(trackIssue("INVALID_REQUEST", `Unrecognized argument(s): ${argv.join(" ")}`));
  }
  // --show, or no flag: read-only by default.
  await showTemplates();
});
