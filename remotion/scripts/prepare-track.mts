import { trackDirLabel } from "../core/domain/tracks/paths.ts";
import { prepareTrack } from "../services/tracks/prepareTrack.ts";
import { describeAnalysis, printMetadataSummary, runCli } from "./cli.ts";

const printUsage = () => {
  console.error(
    [
      "Usage: npm run prepare-track -- <track-slug>",
      "",
      "  <track-slug>   Folder name under public/tracks/, e.g. midnight-rider",
      "",
      "Validates cover.png, beat.wav and metadata.json, and generates/refreshes",
      "the lightweight analysis.wav used for waveform rendering.",
    ].join("\n"),
  );
};

runCli("preparing track", async () => {
  const slug = process.argv[2];

  if (!slug) {
    printUsage();
    process.exit(1);
  }

  console.log(`→ Preparing track "${slug}"...`);
  const { metadata, analysis } = await prepareTrack(slug);

  console.log(`✓ Cover art and audio found in ${trackDirLabel(slug)}`);
  console.log(
    describeAnalysis(analysis, "Waveform analysis audio already up to date"),
  );
  console.log(`✓ Metadata valid:`);
  printMetadataSummary(metadata);

  console.log(`\n✓ Track "${slug}" is ready.`);
  console.log(`  Render it with: npm run render-track -- ${slug}`);
});
