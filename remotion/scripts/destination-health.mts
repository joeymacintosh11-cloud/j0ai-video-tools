import { scanDestinationHealth } from "../server/services/destinationHealth.ts";
import { readDeliverySettings } from "../services/delivery/deliverySettings.ts";
import type {
  DestinationFinding,
  DestinationHealthStatus,
} from "../src/domain/delivery/destinationHealth.ts";
import { TrackError, trackIssue } from "../src/domain/tracks/errors.ts";
import { runCli } from "./cli.ts";

/**
 * Compares the destination against current delivery records and reports
 * drift. Read-only — nothing here writes or deletes anything, ever.
 *
 * Uses the same scan service as the API, so a finding means the same thing in
 * both places and there is no filesystem-walking logic in scripts/.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run destination-health [-- <options>]",
      "",
      "  --track <slug>    Scan only this track (repeatable)",
      "  --json            Print the full result as JSON instead",
      "",
      "With no --track, scans every track under public/tracks/.",
      "Nothing here writes or deletes anything at the destination.",
      "",
      "Examples:",
      "  npm run destination-health",
      "  npm run destination-health -- --track ghetto-geek",
      "  npm run destination-health -- --json",
    ].join("\n"),
  );
};

const parseArgs = (argv: string[]) => {
  const tracks: string[] = [];
  let json = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--track") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new TrackError(
          trackIssue("INVALID_REQUEST", "--track needs a value."),
        );
      }
      tracks.push(value);
      index += 1;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--help") {
      help = true;
    }
  }

  return { tracks, json, help };
};

const STATUS_LABEL: Record<DestinationHealthStatus, string> = {
  not_configured: "No destination configured",
  healthy: "Healthy",
  drift: "Drift found",
  unavailable: "Destination unavailable",
  error: "Scan could not complete",
};

const printFinding = (finding: DestinationFinding) => {
  const mark = finding.severity === "error" ? "✗" : finding.severity === "warning" ? "!" : "·";
  const where = finding.relativePath ?? finding.slug ?? "";
  console.log(`  ${mark} [${finding.severity}] ${finding.message}${where ? ` (${where})` : ""}`);
};

runCli("scanning the destination", async () => {
  const { tracks, json, help } = parseArgs(process.argv.slice(2));

  if (help) {
    printUsage();
    return;
  }

  const settings = await readDeliverySettings();
  const result = await scanDestinationHealth({
    slugs: tracks.length === 0 ? undefined : tracks,
    settings,
  });

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`Destination: ${result.root ?? "(none configured)"}\n`);
    console.log(STATUS_LABEL[result.status]);

    if (result.rootProblem !== null) console.log(`  ${result.rootProblem}`);

    if (result.root !== null) {
      const { counts } = result;
      console.log(
        [
          `${counts.tracksChecked} track(s) checked`,
          `${counts.healthyTracks} healthy`,
          `${counts.tracksWithFindings} with findings`,
        ].join(" · "),
      );
      console.log(
        `${counts.findingsBySeverity.error} error · ` +
          `${counts.findingsBySeverity.warning} warning · ` +
          `${counts.findingsBySeverity.info} info`,
      );

      if (result.rootFindings.length > 0) {
        console.log("\nDestination:");
        for (const finding of result.rootFindings) printFinding(finding);
      }

      for (const track of result.tracks) {
        if (track.findings.length === 0) continue;
        console.log(`\n${track.slug}:`);
        for (const finding of track.findings) printFinding(finding);
      }

      if (result.invalid.length > 0) {
        console.log("\nCould not be scanned:");
        for (const entry of result.invalid) {
          console.log(`  ${entry.slug}: ${entry.reason}`);
        }
      }
    }
  }

  const hasErrorFinding =
    result.counts.findingsBySeverity.error > 0 ||
    result.status === "unavailable" ||
    result.status === "error";

  if (hasErrorFinding) {
    // The scan itself never fails over what it found; this only sets the exit
    // code so the command is useful in a script. Nothing here was changed.
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        "Destination health found at least one error-level finding. Nothing was changed.",
      ),
    );
  }
});
