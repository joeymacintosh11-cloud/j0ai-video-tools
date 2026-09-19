import {
  applyDestinationFixPlan,
  planDestinationFix,
} from "../server/services/destinationFixPlan.ts";
import { readDeliverySettings } from "../services/delivery/deliverySettings.ts";
import type { RemediationAction, RemediationActionResult } from "../src/domain/delivery/destinationFixPlan.ts";
import type { DestinationHealthStatus } from "../src/domain/delivery/destinationHealth.ts";
import { TrackError, trackIssue } from "../src/domain/tracks/errors.ts";
import { runCli } from "./cli.ts";

/**
 * Proposes remediation for current destination drift, and — only with
 * --apply — runs the safe actions the plan describes.
 *
 * Dry run by default, exactly like the API and the UI: this command always
 * shows the plan before anything runs. Uses the same planner/executor as the
 * API, so there is no second copy of the finding-to-action policy in scripts/.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run destination-fix-plan -- [<options>]",
      "",
      "  --track <slug>    Plan only this track (repeatable)",
      "  --json            Print the full result as JSON instead",
      "  --apply           Run the safe actions this plan proposes",
      "",
      "With no --track, plans for every track under public/tracks/.",
      "",
      "DRY RUN by default: no --apply means nothing is changed, however drifted",
      "the destination is. Manual-review items are never run, with or without",
      "--apply — nothing here deletes or replaces a file it did not deliver.",
      "",
      "Examples:",
      "  npm run destination-fix-plan",
      "  npm run destination-fix-plan -- --track ghetto-geek",
      "  npm run destination-fix-plan -- --apply",
    ].join("\n"),
  );
};

const parseArgs = (argv: string[]) => {
  const tracks: string[] = [];
  let json = false;
  let help = false;
  let apply = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--track") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new TrackError(trackIssue("INVALID_REQUEST", "--track needs a value."));
      }
      tracks.push(value);
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--help") {
      help = true;
    } else {
      throw new TrackError(trackIssue("INVALID_REQUEST", `Unknown option: ${arg}`));
    }
  }

  return { tracks, json, help, apply };
};

const STATUS_LABEL: Record<DestinationHealthStatus, string> = {
  not_configured: "No destination configured",
  healthy: "Healthy — nothing to plan",
  drift: "Drift found",
  unavailable: "Destination unavailable",
  error: "Scan could not complete",
};

const printAction = (a: RemediationAction) => {
  const mark = a.safety === "safe" ? "✓" : "!";
  console.log(`  ${mark} ${a.title}`);
  console.log(`      ${a.reason}`);
};

const printResult = (r: RemediationActionResult) => {
  const mark =
    r.status === "completed"
      ? "✓"
      : r.status === "failed" || r.status === "blocked"
        ? "✗"
        : "·";
  console.log(`  ${mark} [${r.status}] ${r.kind}${r.slug ? ` — ${r.slug}` : ""}${r.presetId ? ` / ${r.presetId}` : ""}`);
  if (r.reason !== null) console.log(`      ${r.reason}`);
};

runCli("planning destination remediation", async () => {
  const { tracks, json, help, apply } = parseArgs(process.argv.slice(2));

  if (help) {
    printUsage();
    return;
  }

  const settings = await readDeliverySettings();
  const slugs = tracks.length === 0 ? undefined : tracks;
  const plan = await planDestinationFix({ slugs, settings });

  if (json && !apply) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  console.log(`Destination: ${plan.root ?? "(none configured)"}\n`);
  console.log(STATUS_LABEL[plan.status]);
  if (plan.rootProblem !== null) console.log(`  ${plan.rootProblem}`);

  if (plan.actions.length > 0) {
    console.log(
      `\n${plan.summary.safeActions} safe action(s) · ${plan.summary.manualActions} manual item(s) · ` +
        `${plan.summary.tracksAffected} track(s) affected`,
    );
    console.log(
      `${plan.summary.rendersRequired} render(s) · ${plan.summary.deliveriesRequired} delivery(ies) · ` +
        `${plan.summary.bundleUpdatesRequired} bundle update(s)`,
    );

    const safe = plan.actions.filter((a) => a.safety === "safe");
    const manual = plan.actions.filter((a) => a.safety === "manual");

    if (safe.length > 0) {
      console.log("\nSAFE:");
      for (const a of safe) printAction(a);
    }
    if (manual.length > 0) {
      console.log("\nMANUAL:");
      for (const a of manual) printAction(a);
    }
  }

  if (!apply) {
    console.log("\nDRY RUN — no files were changed. Add --apply to run the safe actions above.");
    return;
  }

  const executable = plan.actions.filter((a) => a.executable);
  if (executable.length === 0) {
    console.log("\nNothing to apply.");
    return;
  }

  console.log(`\nApplying ${executable.length} safe action(s)...`);
  const { results } = await applyDestinationFixPlan({
    slugs,
    settings,
    actionIds: executable.map((a) => a.id),
  });

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log("");
    for (const r of results) printResult(r);
  }

  if (results.some((r) => r.status === "failed")) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "At least one action failed. See results above."),
    );
  }
});
