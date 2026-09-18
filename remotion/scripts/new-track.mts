import { trackDirLabel } from "../src/domain/tracks/paths.ts";
import {
  parseExportPresetList,
  RENDER_PRESET_IDS,
  type RenderPresetId,
} from "../src/domain/video/renderPresets.ts";
import { TrackError, trackIssue } from "../src/domain/tracks/errors.ts";
import { createTrack } from "../services/tracks/createTrack.ts";
import { runCli } from "./cli.ts";

const printUsage = () => {
  console.error(
    [
      'Usage: npm run new-track -- "Track Name" [--presets <id,id>]',
      "",
      `  --presets <ids>   Comma-separated formats this track will ship in.`,
      `                    One of: ${RENDER_PRESET_IDS.join(", ")}`,
      "                    Defaults to youtube-16x9; changeable later.",
      "",
      "Examples:",
      '  npm run new-track -- "Midnight Rider"',
      '  npm run new-track -- "Midnight Rider" --presets youtube-16x9,vertical-9x16',
    ].join("\n"),
  );
};

/** Validated by the shared registry, so the CLI knows no extra format names. */
const parsePresets = (
  argv: string[],
): readonly RenderPresetId[] | undefined => {
  const index = argv.indexOf("--presets");

  if (index === -1) {
    return undefined;
  }

  const value = argv[index + 1];

  if (value === undefined || value.startsWith("--")) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "--presets needs a comma-separated list of format ids."),
    );
  }

  const { presets, problems } = parseExportPresetList(value.split(","));

  if (presets === null) {
    throw new TrackError(trackIssue("INVALID_PRESET", problems.join(" ")));
  }

  return presets;
};

runCli("creating track", async () => {
  const argv = process.argv.slice(2);
  const presets = parsePresets(argv);
  const presetValue = argv[argv.indexOf("--presets") + 1];
  const trackName = argv
    .find((arg) => !arg.startsWith("--") && arg !== presetValue)
    ?.trim();

  if (!trackName) {
    printUsage();
    process.exit(1);
  }

  const { slug, metadata } = await createTrack(trackName, presets);
  const trackDir = trackDirLabel(slug);

  console.log(`✓ Created ${trackDir}`);
  console.log(`✓ Wrote ${trackDir}metadata.json`);
  console.log(`✓ Intended exports: ${(metadata.exportPresets ?? []).join(", ")}`);
  console.log(`\nNext steps:`);
  console.log(`  1. Add cover art:  ${trackDir}cover.png`);
  console.log(`  2. Add the beat:   ${trackDir}beat.wav`);
  console.log(
    `  3. Fill in "key" and "bpm" (currently empty) in ${trackDir}metadata.json`,
  );
  console.log(`  4. Validate:       npm run validate-track -- ${slug}`);
  console.log(`  5. Render:         npm run render-track -- ${slug}`);
});
