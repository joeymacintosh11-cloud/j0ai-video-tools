import { trackDirLabel } from "../src/domain/tracks/paths.ts";
import {
  COMPOSITION_ID,
  renderTrackVideo,
} from "../services/render/renderTrackVideo.ts";
import { prepareTrack } from "../services/tracks/prepareTrack.ts";
import { describeAnalysis, printMetadataSummary, runCli } from "./cli.ts";

const printUsage = () => {
  console.error(
    [
      "Usage: npm run render-track -- <track-slug> [--validate-only]",
      "",
      "  <track-slug>      Folder name under public/tracks/, e.g. ghetto-geek",
      "  --validate-only   Check and prepare the track without rendering",
      "",
      "Example:",
      "  npm run render-track -- ghetto-geek",
    ].join("\n"),
  );
};

const parseArgs = (argv: string[]) => {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const positional = argv.filter((arg) => !arg.startsWith("--"));

  return {
    slug: positional[0],
    validateOnly: flags.includes("--validate-only"),
  };
};

runCli("rendering track", async () => {
  const { slug, validateOnly } = parseArgs(process.argv.slice(2));

  if (!slug) {
    printUsage();
    process.exit(1);
  }

  console.log(`→ Preparing track "${slug}"...`);
  const { metadata, props, analysis } = await prepareTrack(slug);

  printMetadataSummary(metadata);
  console.log(`✓ Cover art and audio found in ${trackDirLabel(slug)}`);
  console.log(describeAnalysis(analysis, "Waveform analysis audio up to date"));

  if (validateOnly) {
    console.log(`\n✓ Track "${slug}" is valid. Skipping render (--validate-only).`);
    return;
  }

  let lastLoggedPercentage = -1;

  const { outputLabel } = await renderTrackVideo({
    slug,
    props,
    onPhase: (phase) => {
      if (phase === "bundling") {
        console.log(`\n→ Bundling Remotion project...`);
      }
      if (phase === "resolving") {
        console.log(
          `→ Resolving composition "${COMPOSITION_ID}" (reading audio duration)...`,
        );
      }
    },
    onResolved: ({ durationInFrames, fps, outputLabel: label }) => {
      const durationInSeconds = (durationInFrames / fps).toFixed(1);
      console.log(
        `✓ Duration resolved: ${durationInFrames} frames @ ${fps}fps (${durationInSeconds}s)`,
      );
      console.log(`\n→ Rendering to ${label} ...`);
    },
    onProgress: ({ progress }) => {
      const percentage = Math.floor(progress * 100);
      if (percentage !== lastLoggedPercentage && percentage % 10 === 0) {
        lastLoggedPercentage = percentage;
        console.log(`  ${percentage}%`);
      }
    },
  });

  console.log(`\n✓ Rendered ${outputLabel}`);
});
