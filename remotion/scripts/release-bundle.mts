import {
  generatePlannedBundles,
  planReleaseBundles,
  type ReleaseBundlePlan,
} from "../server/services/releaseBundlePlan.ts";
import { readDeliverySettings } from "../services/delivery/deliverySettings.ts";
import { TrackError, trackIssue } from "../src/domain/tracks/errors.ts";
import { runCli } from "./cli.ts";

/**
 * Writes release bundles for one track or the whole catalogue.
 *
 * Uses the same planner and the same generation service as the API, so what
 * counts as an outdated bundle means one thing in both places and there is no
 * formatting or path logic in scripts/.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run release-bundle -- <track-slug> [--dry-run] [--force]",
      "       npm run release-bundles [-- --dry-run] [--force]",
      "",
      "  <track-slug>      Folder name under public/tracks/, e.g. ghetto-geek",
      "  --all-tracks      Every track under public/tracks/",
      "  --dry-run         Report what would be written, without writing",
      "  --force           Rewrite bundles that are already current",
      "",
      "Only missing and outdated bundles are written by default. Writes",
      "release.json and release.md into each track's own destination folder.",
      "",
      "Examples:",
      "  npm run release-bundle -- ghetto-geek --dry-run",
      "  npm run release-bundles",
    ].join("\n"),
  );
};

const parseArgs = (argv: string[]) => {
  const flags = argv.filter((arg) => arg.startsWith("--"));
  const positional = argv.filter((arg) => !arg.startsWith("--"));

  return {
    slug: positional[0],
    allTracks: flags.includes("--all-tracks"),
    dryRun: flags.includes("--dry-run"),
    force: flags.includes("--force"),
  };
};

const describePlan = (plan: ReleaseBundlePlan): void => {
  const plural = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;

  console.log(
    [
      plural(plan.tracks, "track"),
      `${plan.current.length} current`,
      `${plan.outdated.length} outdated`,
      `${plan.missing.length} missing`,
      `${plan.unavailable.length} without a destination`,
    ].join(" · "),
  );

  for (const state of plan.unavailable) {
    console.log(`  - ${state.slug}: ${state.problem ?? "no destination configured"}`);
  }
  for (const state of [...plan.missing, ...plan.outdated]) {
    console.log(
      `  → ${state.relativePath} (${state.delivered} delivered, ${state.outdated} outdated, ${state.missing} missing)`,
    );
  }
};

runCli("writing release bundles", async () => {
  const { slug, allTracks, dryRun, force } = parseArgs(process.argv.slice(2));

  if (!slug && !allTracks) {
    printUsage();
    process.exit(1);
  }

  const settings = await readDeliverySettings();
  const plan = await planReleaseBundles({
    slugs: allTracks ? undefined : [slug as string],
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
    console.log(`\n✓ Dry run — nothing written.`);
    return;
  }

  const pending = force
    ? plan.missing.length + plan.outdated.length + plan.current.length
    : plan.missing.length + plan.outdated.length;

  if (pending === 0) {
    console.log(
      `\n✓ ${plan.catalogue ? "Every bundle is current" : "The bundle is current"}.`,
    );
    return;
  }

  console.log("");
  const results = await generatePlannedBundles(plan, { settings, force });
  const failed = results.filter((result) => !result.generated);

  for (const result of results) {
    console.log(
      result.generated
        ? `✓ ${result.relativePath}`
        : `✗ ${result.slug}: ${result.problem ?? "not written"}`,
    );
  }

  if (failed.length > 0) {
    // Bundles are descriptions; nothing that shipped is affected by one failing.
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        `${failed.length} of ${results.length} bundles could not be written. Delivered files are unaffected.`,
      ),
    );
  }

  console.log(`\n✓ Wrote ${results.length} release bundle(s).`);
});
