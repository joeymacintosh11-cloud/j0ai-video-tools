import {
  deliverPlanned,
  planDeliveries,
  type DeliveryPlan,
} from "../server/services/deliveryPlan.ts";
import {
  DELIVERY_SETTINGS_FILE,
  readDeliverySettings,
  writeDeliverySettings,
} from "../services/delivery/deliverySettings.ts";
import { TrackError, trackIssue } from "../src/domain/tracks/errors.ts";
import {
  assertRenderPresetId,
  RENDER_PRESET_IDS,
  type RenderPresetId,
} from "../src/domain/video/renderPresets.ts";
import { runCli } from "./cli.ts";

/**
 * Copies finished exports to the configured local destination.
 *
 * Uses the same planner and the same delivery service as the API, so "what
 * needs delivering" means one thing in both places and there is no copying
 * logic in scripts/. The destination comes from local settings, never from an
 * argument, which is what keeps a mistyped path from writing a video somewhere
 * unintended.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run deliver-track -- <track-slug> [--preset <id>] [--dry-run]",
      "       npm run deliver-catalogue [-- --dry-run]",
      "",
      "  <track-slug>      Folder name under public/tracks/, e.g. ghetto-geek",
      "  --all-tracks      Every track under public/tracks/",
      `  --preset <id>     Limit to one format: ${RENDER_PRESET_IDS.join(", ")}`,
      "  --dry-run         Report the plan without copying anything",
      "  --set-root <dir>  Configure the destination folder and exit",
      "  --show            Print the current destination settings and exit",
      "",
      "Only current exports are delivered. A missing or stale export is",
      "reported so it can be re-rendered first.",
      "",
      "Examples:",
      "  npm run deliver-track -- ghetto-geek --dry-run",
      "  npm run deliver-catalogue",
    ].join("\n"),
  );
};

const parseArgs = (argv: string[]) => {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TrackError(
        trackIssue("INVALID_REQUEST", `${flag} needs a value.`),
      );
    }
    return value;
  };

  const presetValue = valueAfter("--preset");
  const rootValue = flags.includes("--set-root")
    ? valueAfter("--set-root")
    : undefined;
  const positional = argv.filter(
    (arg) =>
      !arg.startsWith("--") && arg !== presetValue && arg !== rootValue,
  );

  return {
    slug: positional[0],
    allTracks: flags.includes("--all-tracks"),
    dryRun: flags.includes("--dry-run"),
    show: flags.includes("--show"),
    setRoot: rootValue,
    presetIds: (presetValue === undefined
      ? null
      : [assertRenderPresetId(presetValue)]) as readonly RenderPresetId[] | null,
  };
};

const describePlan = (plan: DeliveryPlan): void => {
  const plural = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;

  console.log(
    [
      plural(plan.tracks, "track"),
      plural(plan.considered.length, "intended export"),
      `${plan.alreadyDelivered.length} already delivered`,
      `${plan.deliverable.length} to deliver`,
      `${plan.notCurrent.length} not current`,
    ].join(" · "),
  );

  for (const entry of plan.invalid) {
    console.log(`  ! ${entry.slug}: ${entry.reason}`);
  }

  for (const target of plan.notCurrent) {
    // The export's own state is what needs acting on here, not the copy's.
    const why =
      target.freshness === "missing"
        ? "not rendered yet"
        : `export is ${target.freshness}`;
    console.log(`  - ${target.outputLabel} — ${why}; re-render it first`);
  }

  for (const target of plan.deliverable) {
    console.log(`  → ${target.destinationRelativePath}`);
  }
};

runCli("delivering exports", async () => {
  const { slug, allTracks, presetIds, dryRun, show, setRoot } = parseArgs(
    process.argv.slice(2),
  );

  if (setRoot !== undefined) {
    const settings = await writeDeliverySettings({ root: setRoot });
    console.log(`✓ Export destination set to ${settings.root}`);
    console.log(`  Stored in ${DELIVERY_SETTINGS_FILE} (not committed to git).`);
    return;
  }

  if (show) {
    const settings = await readDeliverySettings();
    console.log(`Destination:  ${settings.root ?? "(not configured)"}`);
    console.log(`Auto-deliver: ${settings.autoDeliver ? "on" : "off"}`);
    console.log(`Settings:     ${DELIVERY_SETTINGS_FILE}`);
    return;
  }

  if (!slug && !allTracks) {
    printUsage();
    process.exit(1);
  }

  const settings = await readDeliverySettings();
  const plan = await planDeliveries({
    slugs: allTracks ? undefined : [slug as string],
    presetIds,
    settings,
  });

  if (plan.root === null) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        plan.rootProblem ??
          `No export destination is configured. Set one with: npm run deliver-track -- --set-root "/Users/you/Movies/Toshi Exports"`,
      ),
    );
  }

  console.log(`Destination: ${plan.root}\n`);
  describePlan(plan);

  if (dryRun) {
    console.log(`\n✓ Dry run — nothing copied.`);
    return;
  }

  if (plan.deliverable.length === 0) {
    console.log(
      `\n✓ ${plan.catalogue ? "Catalogue is fully delivered" : "Nothing to deliver"}.`,
    );
    return;
  }

  console.log("");
  const outcomes = await deliverPlanned(plan, settings);
  const failed = outcomes.filter((outcome) => outcome.status !== "delivered");

  for (const outcome of outcomes) {
    console.log(
      outcome.status === "delivered"
        ? `✓ ${outcome.destinationRelativePath}`
        : `✗ ${outcome.slug} / ${outcome.presetId}: ${outcome.message ?? outcome.status}`,
    );
  }

  if (failed.length > 0) {
    // The canonical exports are untouched either way; only the copies failed.
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        `${failed.length} of ${outcomes.length} deliveries failed. The rendered exports in out/ are unaffected.`,
      ),
    );
  }

  console.log(`\n✓ Delivered ${outcomes.length} export(s).`);
});
