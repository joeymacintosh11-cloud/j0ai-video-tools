import {
  assertRenderPresetId,
  RENDER_PRESET_IDS,
  renderPreset,
  type RenderPresetId,
} from "../src/domain/video/renderPresets.ts";
import {
  planMissingExports,
  type ExportPlan,
} from "../server/services/exportPlan.ts";
import { renderTrackVideo } from "../services/render/renderTrackVideo.ts";
import { prepareTrack } from "../services/tracks/prepareTrack.ts";
import type { BeatVisualizerProps } from "../src/BeatVisualizer/BeatVisualizer.ts";
import { runCli } from "./cli.ts";

/**
 * Renders only the exports a track — or the whole catalogue — is missing.
 *
 * The plan comes from the same planner the API uses, so "missing" means the
 * same thing on the command line as it does in the app: the file is not on
 * disk, and the track's own metadata says it should be. Nothing here decides
 * that for itself.
 *
 * Renders run one after another, exactly as `render-track --all-formats`
 * already does: a single render occupies three Chromium tabs, so concurrency
 * stays where it is. A track is prepared once and its analysis audio is reused
 * by every format after it.
 *
 * Work queued in a running server is invisible from here — this is a separate
 * process with no view of that queue — so a render started in the app and one
 * started here can overlap. Use one or the other for a given track.
 */

const printUsage = () => {
  console.error([
    "Usage: npm run render-missing -- <track-slug> [--preset <id>] [--all-formats] [--dry-run]",
    "       npm run render-catalogue-missing [-- --dry-run]",
    "",
    "  <track-slug>      Folder name under public/tracks/, e.g. ghetto-geek",
    "  --all-tracks      Every track under public/tracks/",
    "  --preset <id>     Override the track's intended formats for this run",
    "  --all-formats     Override with every format",
    "  --dry-run         Report the plan without rendering anything",
    "",
    "With no --preset or --all-formats, each track's own exportPresets decide",
    "which formats matter. A track that declares none intends every format.",
    "",
    "Examples:",
    "  npm run render-missing -- ghetto-geek",
    "  npm run render-missing -- ghetto-geek --dry-run",
    "  npm run render-catalogue-missing",
  ].join("\n"));
};

/**
 * Named formats override the tracks' own intent; naming none leaves presetIds
 * null, which is how the planner is told to use each track's metadata.
 */
const parseArgs = (argv: string[]) => {
  const flags = argv.filter((arg) => arg.startsWith("--"));

  // --preset <id>, so the value is the argument after the flag.
  const presetFlagIndex = argv.indexOf("--preset");
  const presetValue =
    presetFlagIndex === -1 ? undefined : argv[presetFlagIndex + 1];
  const positional = argv.filter(
    (arg) => !arg.startsWith("--") && arg !== presetValue,
  );

  const presetIds: readonly RenderPresetId[] | null = flags.includes(
    "--all-formats",
  )
    ? [...RENDER_PRESET_IDS]
    : presetValue === undefined
      ? null
      : [assertRenderPresetId(presetValue)];

  return {
    slug: positional[0],
    allTracks: flags.includes("--all-tracks"),
    dryRun: flags.includes("--dry-run"),
    presetIds,
  };
};

/** The counts a user needs before committing several minutes of rendering. */
const describePlan = (plan: ExportPlan): void => {
  const plural = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;

  console.log(
    [
      plural(plan.tracks, "track"),
      plural(plan.intendedTargets.length, "intended export"),
      `${plan.skippedExisting.length} already rendered`,
      `${plan.missing.length} missing`,
    ].join(" · "),
  );

  for (const entry of plan.invalid) {
    console.log(`  ! ${entry.slug}: ${entry.reason}`);
  }

  for (const target of plan.missing) {
    console.log(`  → ${target.outputLabel}`);
  }
};

runCli("rendering missing exports", async () => {
  const { slug, allTracks, presetIds, dryRun } = parseArgs(
    process.argv.slice(2),
  );

  if (!slug && !allTracks) {
    printUsage();
    process.exit(1);
  }

  const plan = await planMissingExports({
    slugs: allTracks ? undefined : [slug as string],
    presetIds,
  });

  describePlan(plan);

  if (dryRun) {
    console.log(`\n✓ Dry run — nothing rendered.`);
    return;
  }

  if (plan.missing.length === 0) {
    console.log(
      `\n✓ ${plan.catalogue ? "Catalogue is fully exported" : "Nothing missing"}.`,
    );
    return;
  }

  // One preparation per track, reused by each of its formats. Prepared lazily
  // so a catalogue run does not rebuild analysis audio for tracks that turn out
  // to need no renders.
  const prepared = new Map<string, BeatVisualizerProps>();

  for (const [index, target] of plan.missing.entries()) {
    const preset = renderPreset(target.presetId);
    let props = prepared.get(target.slug);

    if (props === undefined) {
      console.log(`\n→ Preparing "${target.slug}"...`);
      ({ props } = await prepareTrack(target.slug));
      prepared.set(target.slug, props);
    }

    console.log(
      `\n→ [${index + 1}/${plan.missing.length}] ${target.slug} — ${preset.label} (${preset.width}x${preset.height})`,
    );

    let lastLoggedPercentage = -1;

    const { outputLabel } = await renderTrackVideo({
      slug: target.slug,
      props,
      presetId: target.presetId,
      onProgress: ({ progress }) => {
        const percentage = Math.floor(progress * 100);
        if (percentage !== lastLoggedPercentage && percentage % 10 === 0) {
          lastLoggedPercentage = percentage;
          console.log(`  ${percentage}%`);
        }
      },
    });

    console.log(`✓ Rendered ${outputLabel}`);
  }

  console.log(`\n✓ Rendered ${plan.missing.length} missing export(s).`);
});
