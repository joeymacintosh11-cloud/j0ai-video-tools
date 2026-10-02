import {
  applyDestinationFixPlan,
  planDestinationFix,
} from "../server/services/destinationFixPlan.ts";
import { renderManager } from "../server/services/renderManager.ts";
import { isTerminalStatus } from "../server/types.ts";
import { readDeliverySettings } from "../services/delivery/deliverySettings.ts";
import type { RemediationAction, RemediationActionResult } from "../core/domain/delivery/destinationFixPlan.ts";
import type { DestinationHealthStatus } from "../core/domain/delivery/destinationHealth.ts";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import { runCli } from "./cli.ts";

/**
 * Proposes remediation for current destination drift, and — only with
 * --apply — runs the safe actions the plan describes.
 *
 * Dry run by default, exactly like the API and the UI: this command always
 * shows the plan before anything runs. Uses the same planner/executor as the
 * API, so there is no second copy of the finding-to-action policy in scripts/.
 *
 * --wait follows a rerender_and_deliver action through to a confirmed final
 * result. It works exactly like the UI does: a first, fast apply-plan call
 * queues any render and reports its job id; this script then polls the same
 * in-process render manager the API itself reads from (a short, bounded
 * interval, purely for what to print here — never a new job store), and once
 * every followed job is terminal, a second apply-plan call with
 * waitForCompletion and the exact job ids chains delivery, a bundle update, and a health
 * confirmation through to the real final outcome.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run destination-fix-plan -- [<options>]",
      "",
      "  --track <slug>     Plan only this track (repeatable)",
      "  --json             Print the full result as JSON instead",
      "  --apply            Run the safe actions this plan proposes",
      "  --wait             Follow a queued render through to delivery",
      "  --timeout <secs>   Bound the wait (default 300, only with --wait)",
      "",
      "With no --track, plans for every track under public/tracks/.",
      "",
      "DRY RUN by default: no --apply means nothing is changed, however drifted",
      "the destination is. Manual-review items are never run, with or without",
      "--apply — nothing here deletes or replaces a file it did not deliver.",
      "",
      "Without --wait, a rerender_and_deliver action only ever queues its",
      "render and reports [queued] — never a false success. --timeout stops",
      "this script from waiting, not the render itself, which keeps going.",
      "",
      "Examples:",
      "  npm run destination-fix-plan",
      "  npm run destination-fix-plan -- --track ghetto-geek",
      "  npm run destination-fix-plan -- --apply",
      "  npm run destination-fix-plan -- --apply --wait --timeout 600",
    ].join("\n"),
  );
};

const DEFAULT_WAIT_SECONDS = 300;

const parseArgs = (argv: string[]) => {
  const tracks: string[] = [];
  let json = false;
  let help = false;
  let apply = false;
  let wait = false;
  let timeoutSeconds = DEFAULT_WAIT_SECONDS;

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
    } else if (arg === "--wait") {
      wait = true;
    } else if (arg === "--timeout") {
      const value = argv[index + 1];
      const parsed = value === undefined ? NaN : Number(value);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new TrackError(trackIssue("INVALID_REQUEST", "--timeout needs a positive number of seconds."));
      }
      timeoutSeconds = Math.min(parsed, 1800);
      index += 1;
    } else if (arg === "--help") {
      help = true;
    } else {
      throw new TrackError(trackIssue("INVALID_REQUEST", `Unknown option: ${arg}`));
    }
  }

  return { tracks, json, help, apply, wait, timeoutSeconds };
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

const FAILURE_STATUSES: ReadonlySet<RemediationActionResult["status"]> = new Set([
  "failed",
  "blocked",
  "render_failed",
  "delivery_failed",
  "cancelled",
  "timed_out",
]);

const printResult = (r: RemediationActionResult) => {
  const mark = r.status === "completed" ? "✓" : FAILURE_STATUSES.has(r.status) ? "✗" : "·";
  console.log(`  ${mark} [${r.status}] ${r.kind}${r.slug ? ` — ${r.slug}` : ""}${r.presetId ? ` / ${r.presetId}` : ""}`);
  if (r.reason !== null) console.log(`      ${r.reason}`);
  if (r.healthConfirmed === true) console.log("      Destination health confirmed for this track.");
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Polls the in-process render manager — the same store the API reads —
 * purely to print progress while waiting, at a short bounded interval, never
 * a busy loop. Returns once every named job is terminal or the deadline
 * passes; either way, no job is ever cancelled by this.
 */
const POLL_INTERVAL_MS = 1000;

const followQueuedJobs = async (
  jobs: readonly { readonly title: string; readonly jobId: string }[],
  timeoutMs: number,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  const lastPrinted = new Map<string, string>();

  for (;;) {
    let allTerminal = true;

    for (const { title, jobId } of jobs) {
      let job;
      try {
        job = renderManager.getJob(jobId);
      } catch {
        continue; // Gone from the server's memory; the confirm call will report this plainly.
      }

      const label =
        job.status === "rendering" ? `rendering ${Math.round(job.progress * 100)}%` : job.status;
      if (lastPrinted.get(jobId) !== label) {
        console.log(`  [${label}] ${title}`);
        lastPrinted.set(jobId, label);
      }
      if (!isTerminalStatus(job.status)) allTerminal = false;
    }

    if (allTerminal || Date.now() >= deadline) return allTerminal;
    await sleep(POLL_INTERVAL_MS);
  }
};

runCli("planning destination remediation", async () => {
  const { tracks, json, help, apply, wait, timeoutSeconds } = parseArgs(process.argv.slice(2));

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

  const actionIds = executable.map((a) => a.id);
  const titleById = new Map(plan.actions.map((a) => [a.id, a.title]));

  console.log(`\nApplying ${executable.length} safe action(s)...`);
  const first = await applyDestinationFixPlan({ slugs, actionIds });

  const queuedJobs = first.results
    .filter((r): r is RemediationActionResult & { jobId: string } => r.status === "queued" && r.jobId !== null)
    .map((r) => ({ jobId: r.jobId, title: titleById.get(r.actionId) ?? r.kind }));

  let results = first.results;

  if (queuedJobs.length > 0 && wait) {
    console.log(`\nWaiting up to ${timeoutSeconds}s for ${queuedJobs.length} render(s)...`);
    const allTerminal = await followQueuedJobs(queuedJobs, timeoutSeconds * 1000);
    if (allTerminal) {
      const confirmed = await applyDestinationFixPlan({
        slugs,
        actionIds,
        waitForCompletion: true,
        timeoutMs: 30000,
        followJobs: first.results
          .filter((r): r is RemediationActionResult & { jobId: string } => r.status === "queued" && r.jobId !== null)
          .map((r) => ({ actionId: r.actionId, jobId: r.jobId })),
      });
      results = confirmed.results;
    } else {
      // The caller's deadline has passed. Return the queued actions as
      // timed-out observations; the jobs keep running, without a late confirm
      // call extending this CLI invocation or starting delivery afterward.
      results = first.results.map((result) => result.status === "queued"
        ? { ...result, status: "timed_out" as const,
            reason: `Stopped waiting after ${timeoutSeconds}s. Job ${result.jobId} continues independently.` }
        : result);
    }
  }

  if (json) {
    console.log(JSON.stringify(results, null, 2));
  } else {
    console.log("");
    for (const r of results) printResult(r);
    if (queuedJobs.length > 0 && !wait) {
      console.log(
        `\n${queuedJobs.length} render(s) queued but not followed. Add --wait to follow them through delivery.`,
      );
    }
  }

  if (results.some((r) => FAILURE_STATUSES.has(r.status))) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "At least one action did not complete cleanly. See results above."),
    );
  }
});
