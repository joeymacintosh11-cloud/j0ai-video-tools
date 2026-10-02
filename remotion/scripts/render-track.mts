import { renderEngines } from "../adapters/renderEngines.mts";
import { trackDirLabel } from "../core/domain/tracks/paths.ts";
import {
  assertRenderPresetId,
  RENDER_PRESET_IDS,
  renderPreset,
  type RenderPresetId,
} from "../core/domain/video/renderPresets.ts";
import {
  COMPOSITION_ID,
  renderTrackVideo,
} from "../services/render/renderTrackVideo.ts";
import { prepareTrack } from "../services/tracks/prepareTrack.ts";
import { describeAnalysis, printMetadataSummary, runCli, printLibraryOutcome } from "./cli.ts";

const printUsage = () => {
  console.error(
    [
      "Usage: npm run render-track -- <track-slug> [--preset <id>] [--all-formats] [--validate-only]",
      "",
      "  <track-slug>      Folder name under public/tracks/, e.g. ghetto-geek",
      `  --preset <id>     Export format; one of: ${RENDER_PRESET_IDS.join(", ")}`,
      "                    Defaults to youtube-16x9 when omitted.",
      "  --all-formats     Render every format, one after another",
      "  --validate-only   Check and prepare the track without rendering",
      "",
      "Examples:",
      "  npm run render-track -- ghetto-geek",
      "  npm run render-track -- ghetto-geek --preset vertical-9x16",
      "  npm run render-track -- ghetto-geek --all-formats",
    ].join("\n"),
  );
};

const parseArgs = (argv: string[]) => {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const positional = argv.filter((arg) => !arg.startsWith("--"));

  // --preset <id>, so the value is the argument after the flag.
  const presetFlagIndex = argv.indexOf("--preset");
  const presetValue =
    presetFlagIndex === -1 ? undefined : argv[presetFlagIndex + 1];

  return {
    slug: positional[0] === presetValue ? positional[1] : positional[0],
    presetValue,
    allFormats: flags.includes("--all-formats"),
    validateOnly: flags.includes("--validate-only"),
  };
};

runCli("rendering track", async () => {
  const { slug, presetValue, allFormats, validateOnly } = parseArgs(
    process.argv.slice(2),
  );

  if (!slug) {
    printUsage();
    process.exit(1);
  }

  // Throws a structured INVALID_PRESET before any work happens.
  const presetIds: RenderPresetId[] = allFormats
    ? [...RENDER_PRESET_IDS]
    : [assertRenderPresetId(presetValue)];

  console.log(`→ Preparing track "${slug}"...`);
  const { metadata, props, analysis } = await prepareTrack(slug);

  printMetadataSummary(metadata);
  console.log(`✓ Cover art and audio found in ${trackDirLabel(slug)}`);
  console.log(describeAnalysis(analysis, "Waveform analysis audio up to date"));

  if (validateOnly) {
    console.log(`\n✓ Track "${slug}" is valid. Skipping render (--validate-only).`);
    return;
  }

  if (presetIds.length > 1) {
    console.log(
      `\n→ Rendering ${presetIds.length} formats: ${presetIds.join(", ")}`,
    );
  }

  // One at a time, deliberately: a render already uses three Chromium tabs.
  // The analysis audio prepared above is reused by every format.
  const rendered: string[] = [];

  for (const presetId of presetIds) {
    const preset = renderPreset(presetId);
    let lastLoggedPercentage = -1;

    console.log(`\n→ ${preset.label} (${preset.width}x${preset.height})`);

    const { outputLabel } = await renderTrackVideo({
      engine: await renderEngines.resolve(undefined),
      slug,
      props,
      onRecorded: printLibraryOutcome,
      presetId,
      onPhase: (phase) => {
        if (phase === "bundling") {
          console.log(`→ Bundling Remotion project...`);
        }
        if (phase === "resolving") {
          console.log(
            `→ Resolving composition "${COMPOSITION_ID}" (reading audio duration)...`,
          );
        }
      },
      onResolved: ({ durationInFrames, fps, width, height, outputLabel: label }) => {
        const durationInSeconds = (durationInFrames / fps).toFixed(1);
        console.log(
          `✓ Duration resolved: ${durationInFrames} frames @ ${fps}fps (${durationInSeconds}s), ${width}x${height}`,
        );
        console.log(`→ Rendering to ${label} ...`);
      },
      onDelivery: (outcome) => {
        console.log(
          outcome.status === "delivered"
            ? `✓ Delivered to ${outcome.destinationRelativePath}`
            : `! Not delivered: ${outcome.message ?? outcome.status}`,
        );
      },
      onProgress: ({ progress }) => {
        const percentage = Math.floor(progress * 100);
        if (percentage !== lastLoggedPercentage && percentage % 10 === 0) {
          lastLoggedPercentage = percentage;
          console.log(`  ${percentage}%`);
        }
      },
    });

    rendered.push(outputLabel);
    console.log(`✓ Rendered ${outputLabel}`);
  }

  if (rendered.length > 1) {
    console.log(`\n✓ Rendered ${rendered.length} formats:`);
    for (const label of rendered) {
      console.log(`    ${label}`);
    }
  }
});
