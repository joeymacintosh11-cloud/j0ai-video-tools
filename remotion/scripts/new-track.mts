import { trackDirLabel } from "../src/domain/tracks/paths.ts";
import { createTrack } from "../services/tracks/createTrack.ts";
import { runCli } from "./cli.ts";

const printUsage = () => {
  console.error(
    [
      'Usage: npm run new-track -- "Track Name"',
      "",
      "Example:",
      '  npm run new-track -- "Midnight Rider"',
    ].join("\n"),
  );
};

runCli("creating track", async () => {
  const trackName = process.argv[2]?.trim();

  if (!trackName) {
    printUsage();
    process.exit(1);
  }

  const { slug } = await createTrack(trackName);
  const trackDir = trackDirLabel(slug);

  console.log(`✓ Created ${trackDir}`);
  console.log(`✓ Wrote ${trackDir}metadata.json`);
  console.log(`\nNext steps:`);
  console.log(`  1. Add cover art:  ${trackDir}cover.png`);
  console.log(`  2. Add the beat:   ${trackDir}beat.wav`);
  console.log(
    `  3. Fill in "key" and "bpm" (currently empty) in ${trackDir}metadata.json`,
  );
  console.log(`  4. Validate:       npm run validate-track -- ${slug}`);
  console.log(`  5. Render:         npm run render-track -- ${slug}`);
});
