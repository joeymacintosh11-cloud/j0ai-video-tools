import { rendererWorkspace } from "../services/render/rendererWorkspace.ts";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import { runCli } from "./cli.ts";

runCli("maintaining the renderer workspace", async () => {
  const flags = process.argv.slice(2);
  if (
    flags.some(
      (arg) =>
        !["--cleanup", "--prune", "--apply", "--dry-run", "--json"].includes(
          arg,
        ),
    )
  ) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        "Usage: npm run ae-workspace -- [--cleanup] [--prune] [--dry-run | --apply] [--json]",
      ),
    );
  }
  if (flags.includes("--apply") && flags.includes("--dry-run"))
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Choose --apply or --dry-run."),
    );
  const mutate = flags.includes("--cleanup") || flags.includes("--prune");
  if (flags.includes("--apply") && !mutate)
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "--apply needs --cleanup or --prune."),
    );
  if (!mutate) {
    const state = await rendererWorkspace().inspect();
    if (flags.includes("--json")) console.log(JSON.stringify(state));
    else {
      console.log(
        state.problem ??
          `AE workspace: ${state.activeJobs} active jobs, ${state.orphanedLocks} orphaned locks, ${state.manual} manual inspection items. Prepared cache: ${state.cacheEntries} entries, ${(state.cacheBytes / 1048576).toFixed(1)} MB.`,
      );
      for (const item of state.artifacts)
        console.log(
          `${item.kind}: ${item.path} — ${item.reason ?? "validated"}; ${item.safe ? "safe cleanup" : "retained"}. ${item.details}`,
        );
    }
    return;
  }
  const result = await rendererWorkspace().maintain({
    dryRun: !flags.includes("--apply"),
    prune: flags.includes("--prune"),
  });
  if (flags.includes("--json")) console.log(JSON.stringify(result));
  else {
    console.log(
      result.dryRun
        ? "Dry run — no files deleted."
        : "Safe maintenance completed.",
    );
    for (const item of result.candidates)
      console.log(
        `Would remove: ${item.path}${item.relatedPaths?.length ? ` + ${item.relatedPaths.join(" + ")}` : ""} — ${item.reason}; ${item.details}`,
      );
    for (const file of result.removed) console.log(`Removed: ${file}`);
    for (const failure of result.failures)
      console.error(`cleanup_failed: ${failure.path}: ${failure.message}`);
    console.log(
      `${result.inspection.manual} artifacts still require manual inspection.`,
    );
  }
  if (result.failures.length) process.exitCode = 1;
});
