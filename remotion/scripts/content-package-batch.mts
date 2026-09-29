import {
  deriveBatchContentPackage,
  planContentPackageBatch,
  type BatchContentPackageView,
  type ContentPackageBatchPlan,
} from "../src/domain/content/contentPackageBatch.ts";
import { assertPlatformId, type PlatformId } from "../src/domain/content/platformProfiles.ts";
import { TrackError, trackIssue } from "../src/domain/tracks/errors.ts";
import {
  buildContentPackagesForSlugs,
  loadContentPackageBatchContext,
  namedBatchSlugs,
} from "../server/services/contentPackagePlan.ts";
import { renderTrackVideo } from "../services/render/renderTrackVideo.ts";
import { prepareTrack } from "../services/tracks/prepareTrack.ts";
import { listTracks } from "../services/tracks/listTracks.ts";
import type { BeatVisualizerProps } from "../src/BeatVisualizer/BeatVisualizer.ts";
import { runCli, printLibraryOutcome } from "./cli.ts";

/**
 * Inspects, plans, and optionally builds Content Packages for several tracks
 * at once.
 *
 * Uses the exact same per-track resolver as the single-track CLI and API
 * (`deriveContentPackage`, by way of `buildContentPackagesForSlugs`), and the
 * exact same render call as `render-missing.mts`/`content-package.mts` —
 * this is not a second rendering system, only orchestration across several
 * tracks. Default behaviour is inspection only; nothing is planned or
 * rendered unless `--plan`/`--apply` is given, and `--apply` implies
 * planning first.
 *
 * `--catalogue` resolves to every current track before doing anything else,
 * so the rest of this script only ever deals with an explicit track list —
 * there is no separate "whole catalogue" code path to keep in sync with the
 * named-tracks one, and a request that named nothing and forgot `--catalogue`
 * is a usage error, not a silent catalogue-wide run.
 *
 * Runs in a separate process from any running server, exactly like the other
 * CLIs here: work queued in the app's own render queue is invisible from
 * here, and vice versa. Renders happen sequentially, one Chromium job at a
 * time, each track prepared once and reused across its own selected formats.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run content-package-batch -- --track <slug> [--track <slug>]...",
      "       npm run content-package-batch -- --tracks a,b,c",
      "       npm run content-package-batch -- --catalogue",
      "",
      "  --track <slug>    A track to include; repeatable.",
      "  --tracks a,b,c    Comma-separated tracks, instead of repeating --track.",
      "  --catalogue       Every track currently under public/tracks/ — must be",
      "                    named explicitly; there is no implicit catalogue mode.",
      "  --mode <mode>     intent (default) or full — same meaning as the",
      "                    single-track content-package command.",
      "  --platform <id>   Restrict to this platform; repeatable. Overrides --mode.",
      "  --plan            Also compute and print what applying would queue.",
      "  --apply           Build the plan's missing/stale outputs (implies --plan).",
      "  --json            Print machine-readable JSON instead of text.",
      "",
      "With no --plan/--apply, this only inspects and reports — nothing is",
      "queued or rendered.",
      "",
      "Examples:",
      "  npm run content-package-batch -- --track beat-a --track beat-b",
      "  npm run content-package-batch -- --tracks beat-a,beat-b --mode full --plan",
      "  npm run content-package-batch -- --catalogue --apply",
    ].join("\n"),
  );
};

const collectRepeatable = (argv: string[], flag: string): string[] => {
  const values: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === flag) {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new TrackError(
          trackIssue("INVALID_REQUEST", `${flag} needs a value.`),
        );
      }
      values.push(value);
    }
  }
  return values;
};

const parseArgs = (argv: string[]) => {
  const modeIndex = argv.indexOf("--mode");
  const modeValue = modeIndex === -1 ? undefined : argv[modeIndex + 1];
  if (modeIndex !== -1 && modeValue === undefined) {
    throw new TrackError(trackIssue("INVALID_REQUEST", "--mode needs a value."));
  }
  if (modeValue !== undefined && modeValue !== "intent" && modeValue !== "full") {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", '--mode must be "intent" or "full".'),
    );
  }

  const trackFlags = collectRepeatable(argv, "--track");
  const tracksIndex = argv.indexOf("--tracks");
  const tracksValue = tracksIndex === -1 ? undefined : argv[tracksIndex + 1];
  const listed = [
    ...trackFlags,
    ...(tracksValue ? tracksValue.split(",").map((s) => s.trim()).filter(Boolean) : []),
  ];

  const platforms: PlatformId[] = collectRepeatable(argv, "--platform").map((value) =>
    assertPlatformId(value),
  );

  return {
    tracks: listed,
    catalogue: argv.includes("--catalogue"),
    mode: (modeValue ?? "intent") as "intent" | "full",
    platforms: platforms.length > 0 ? platforms : undefined,
    plan: argv.includes("--plan") || argv.includes("--apply"),
    apply: argv.includes("--apply"),
    json: argv.includes("--json"),
  };
};

const describeInspect = (view: BatchContentPackageView): void => {
  const t = view.totals;
  console.log(
    `${t.tracks} track${t.tracks === 1 ? "" : "s"} · ${t.totalPlatformTargets} platform target${t.totalPlatformTargets === 1 ? "" : "s"}`,
  );
  console.log(
    `${t.readyTargets} ready · ${t.missingTargets} missing · ${t.staleTargets} stale${t.rendering > 0 ? ` · ${t.rendering} rendering` : ""}`,
  );
  console.log(
    `Per track: ${t.complete} complete · ${t.incomplete} incomplete · ${t.stale} stale · ${t.blocked} blocked`,
  );
  for (const track of view.tracks) {
    console.log(
      `  ${(track.title ?? track.slug).padEnd(28)} ${track.packageStatus.padEnd(12)} ${track.readyCount}/${track.readyCount + track.missingCount + track.staleCount + track.renderingCount + track.blockedCount} ready`,
    );
  }
  for (const entry of view.invalid) {
    console.log(`  ! ${entry.slug}: ${entry.reason}`);
  }
  if (view.duplicates.length > 0) {
    console.log(`  (ignored repeated: ${view.duplicates.join(", ")})`);
  }
};

const describePlan = (plan: ContentPackageBatchPlan): void => {
  console.log(
    `\n${plan.renderable.length} action${plan.renderable.length === 1 ? "" : "s"} to build · ` +
      `${plan.adopted.length} already in flight · ${plan.ready.length} already ready · ${plan.blocked.length} blocked`,
  );
  for (const action of plan.renderable) {
    console.log(
      `  → ${action.slug} / ${action.label} — ${action.kind === "rerender_stale" ? "replace stale export" : "new export"}`,
    );
  }
  for (const action of plan.blocked) {
    console.log(`  ! ${action.slug} / ${action.label}: ${action.reason}`);
  }
};

runCli("inspecting content package batch", async () => {
  const { tracks, catalogue, mode, platforms, plan: wantsPlan, apply, json } =
    parseArgs(process.argv.slice(2));

  if (tracks.length === 0 && !catalogue) {
    printUsage();
    process.exit(1);
  }
  if (tracks.length > 0 && catalogue) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Provide either tracks or --catalogue, not both."),
    );
  }

  const requested = catalogue
    ? (await listTracks()).map((track) => track.slug)
    : tracks;

  const { slugs, duplicates } = namedBatchSlugs(requested);
  const context = await loadContentPackageBatchContext();
  const results = await buildContentPackagesForSlugs(slugs, context, {
    mode,
    platforms,
  });

  const invalid = results
    .filter((r): r is Extract<typeof r, { found: false }> => !r.found)
    .map((r) => ({ slug: r.slug, reason: r.reason }));
  const packages = results
    .filter((r): r is Extract<typeof r, { found: true }> => r.found)
    .map((r) => r.package);

  const inspectView = deriveBatchContentPackage(packages, { invalid, duplicates });

  if (!wantsPlan) {
    if (json) console.log(JSON.stringify(inspectView, null, 2));
    else {
      describeInspect(inspectView);
      console.log(`\n✓ Inspection only — nothing planned or rendered. Add --plan to plan, --apply to build.`);
    }
    return;
  }

  const plan = planContentPackageBatch(results, { duplicates });

  if (!apply) {
    if (json) console.log(JSON.stringify({ inspect: inspectView, plan }, null, 2));
    else {
      describeInspect(inspectView);
      describePlan(plan);
      console.log(`\n✓ Plan only — nothing rendered. Add --apply to build.`);
    }
    return;
  }

  if (!json) {
    describeInspect(inspectView);
    describePlan(plan);
  }

  if (plan.renderable.length === 0) {
    console.log(`\n✓ Nothing to build — everything is ready, in flight, or blocked.`);
    return;
  }

  // One preparation per track, reused by each of its own selected formats —
  // exactly render-missing.mts's own memoization, extended across tracks.
  const prepared = new Map<string, BeatVisualizerProps>();

  for (const [index, action] of plan.renderable.entries()) {
    let props = prepared.get(action.slug);
    if (props === undefined) {
      console.log(`\n→ Preparing "${action.slug}"...`);
      ({ props } = await prepareTrack(action.slug));
      prepared.set(action.slug, props);
    }

    console.log(
      `\n→ [${index + 1}/${plan.renderable.length}] ${action.slug} — ${action.label}`,
    );

    let lastLoggedPercentage = -1;

    const { outputLabel } = await renderTrackVideo({
      slug: action.slug,
      props,
      onRecorded: printLibraryOutcome,
      presetId: action.presetId,
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

  console.log(`\n✓ Built ${plan.renderable.length} export(s) across this batch.`);
});
