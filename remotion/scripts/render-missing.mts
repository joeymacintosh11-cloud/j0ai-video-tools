import { remotionRenderEngine } from "../adapters/remotion/remotionRenderEngine.mts";
import { assertExportMode } from "../core/domain/video/exportFreshness.ts";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import {
  assertRenderPresetId,
  RENDER_PRESET_IDS,
  renderPreset,
  type RenderPresetId,
} from "../core/domain/video/renderPresets.ts";
import {
  planMissingExports,
  type ExportPlan,
} from "../server/services/exportPlan.ts";
import { renderTrackVideo } from "../services/render/renderTrackVideo.ts";
import { prepareTrack } from "../services/tracks/prepareTrack.ts";
import type { VisualizerProps } from "../core/domain/video/visualizerProps.ts";
import { runCli, printLibraryOutcome } from "./cli.ts";

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
  console.error(
    [
      "Usage: npm run render-missing -- <track-slug> [--preset <id>] [--all-formats] [--dry-run]",
      "       npm run render-catalogue-missing [-- --dry-run]",
      "",
      "  <track-slug>      Folder name under public/tracks/, e.g. ghetto-geek",
      "  --all-tracks      Every track under public/tracks/",
      "  --preset <id>     Override the track's intended formats for this run",
      "  --all-formats     Override with every format",
      "  --dry-run         Report the plan without rendering anything",
      "  --mode <mode>     missing (default), stale, or missing-and-stale",
      "  --replace         Confirm replacement of stale exports in this run",
      "",
      "With no --preset or --all-formats, each track's own exportPresets decide",
      "which formats matter. A track that declares none intends every format.",
      "",
      "Examples:",
      "  npm run render-missing -- ghetto-geek",
      "  npm run render-missing -- ghetto-geek --dry-run",
      "  npm run render-catalogue-missing",
    ].join("\n"),
  );
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
  const modeIndex = argv.indexOf("--mode");
  const modeValue = modeIndex === -1 ? undefined : argv[modeIndex + 1];
  if (modeIndex !== -1 && modeValue === undefined)
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "--mode needs a value."),
    );
  const mode = assertExportMode(modeValue);
  const positional = argv.filter(
    (arg) => !arg.startsWith("--") && arg !== presetValue && arg !== modeValue,
  );

  const presetIds: readonly RenderPresetId[] | null = flags.includes(
    "--all-formats",
  )
    ? [...RENDER_PRESET_IDS]
    : presetValue === undefined
      ? null
      : [assertRenderPresetId(presetValue)];

  return {
    mode,
    replace: flags.includes("--replace"),
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
      `${plan.current.length} current`,
      `${plan.stale.length} stale`,
      `${plan.missing.length} missing`,
    ].join(" · "),
  );

  for (const entry of plan.invalid) {
    console.log(`  ! ${entry.slug}: ${entry.reason}`);
  }

  for (const target of plan.selected) {
    console.log(
      `  → ${target.outputLabel}${target.staleReasons?.length ? " (replace stale export)" : " (new export)"}`,
    );
  }
};

runCli("rendering missing exports", async () => {
  const { slug, allTracks, presetIds, dryRun, mode, replace } = parseArgs(
    process.argv.slice(2),
  );

  if (!slug && !allTracks) {
    printUsage();
    process.exit(1);
  }

  const plan = await planMissingExports({
    mode,
    slugs: allTracks ? undefined : [slug as string],
    presetIds,
  });

  describePlan(plan);

  if (dryRun) {
    console.log(`\n✓ Dry run — nothing rendered.`);
    return;
  }

  if (plan.selected.length === 0) {
    console.log(`\n✓ No matching exports to render (${mode}).`);
    return;
  }

  if (!replace && plan.selected.some((target) => target.staleReasons?.length)) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        "This plan replaces stale exports. Review it with --dry-run, then add --replace to confirm the batch. Existing videos remain until replacement succeeds.",
      ),
    );
  }

  // One preparation per track, reused by each of its formats. Prepared lazily
  // so a catalogue run does not rebuild analysis audio for tracks that turn out
  // to need no renders.
  const prepared = new Map<string, VisualizerProps>();

  for (const [index, target] of plan.selected.entries()) {
    const preset = renderPreset(target.presetId);
    let props = prepared.get(target.slug);

    if (props === undefined) {
      console.log(`\n→ Preparing "${target.slug}"...`);
      ({ props } = await prepareTrack(target.slug));
      prepared.set(target.slug, props);
    }

    console.log(
      `\n→ [${index + 1}/${plan.selected.length}] ${target.slug} — ${preset.label} (${preset.width}x${preset.height})`,
    );

    let lastLoggedPercentage = -1;

    const { outputLabel } = await renderTrackVideo({
      engine: remotionRenderEngine,
      slug: target.slug,
      props,
      onRecorded: printLibraryOutcome,
      presetId: target.presetId,
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

    console.log(`✓ Rendered ${outputLabel}`);
  }

  console.log(`\n✓ Rendered ${plan.selected.length} export(s).`);
});
