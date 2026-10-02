import {
  DELIVERY_HISTORY_MAX_LIMIT,
  DELIVERY_LOG_FILENAME,
  DELIVERY_LOG_STATUS_NOTES,
  parseRelativePeriod,
  selectDeliveryHistory,
  summarizeDeliveryHistory,
  type DeliveryLogEvent,
} from "../core/domain/delivery/deliveryHistory.ts";
import {
  readDeliveryLog,
  releaseDeliveryLogLock,
  repairDeliveryLogTail,
  writeDeliveryReport,
} from "../services/delivery/deliveryHistoryLog.ts";
import { readDeliverySettings } from "../services/delivery/deliverySettings.ts";
import {
  queryDeliveryHistory,
  reconcileDeliveryHistory,
} from "../services/workflows/deliveryHistory.ts";
import {
  formatBundleTimestamp,
  formatBytes,
} from "../core/domain/delivery/releaseBundle.ts";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import { RENDER_PRESET_IDS } from "../core/domain/video/renderPresets.ts";
import { runCli } from "./cli.ts";

/**
 * Reads the destination's append-only delivery history.
 *
 * Uses the same query service as the API, so a filter means the same thing in
 * both places and there is no parsing or business logic in scripts/. The
 * destination comes from local settings, never from an argument.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run delivery-history [-- <options>]",
      "       npm run delivery-history-reconcile",
      "",
      "  --track <slug>    Only this track",
      `  --preset <id>     Only this format: ${RENDER_PRESET_IDS.join(", ")}`,
      "  --since <period>  From 7d, 24h, or an ISO timestamp",
      "  --until <when>    Up to (but not including) this ISO timestamp",
      "  --limit <n>       How many events to print (default 20, max " +
        `${DELIVERY_HISTORY_MAX_LIMIT})`,
      "  --oldest          Oldest first (default is newest first)",
      "  --report          Also write delivery-report.md to the destination",
      "  --reconcile       Append events for receipts that have none",
      "  --repair-tail     Drop an incomplete final line, and nothing else",
      "  --release-lock    Clear an append lock no live process here holds",
      "",
      "History is append-only: nothing here deletes or rewrites an event.",
      "",
      "Examples:",
      "  npm run delivery-history",
      "  npm run delivery-history -- --track ghetto-geek",
      "  npm run delivery-history -- --since 7d --report",
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

  const limit = valueAfter("--limit");

  if (limit !== undefined && !/^\d{1,4}$/.test(limit)) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "--limit needs a whole number."),
    );
  }

  return {
    track: valueAfter("--track"),
    preset: valueAfter("--preset"),
    since: valueAfter("--since"),
    until: valueAfter("--until"),
    limit: limit === undefined ? 20 : Number(limit),
    oldest: flags.includes("--oldest"),
    report: flags.includes("--report"),
    reconcile: flags.includes("--reconcile"),
    repairTail: flags.includes("--repair-tail"),
    releaseLock: flags.includes("--release-lock"),
    help: flags.includes("--help"),
  };
};

/** An ISO timestamp, or a relative period such as "7d". */
const instant = (value: string | undefined, flag: string): string | null => {
  if (value === undefined) return null;

  const relative = parseRelativePeriod(value);
  if (relative !== null) return relative;

  if (Number.isNaN(Date.parse(value))) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        `${flag} needs a period such as 7d or 24h, or an ISO timestamp. Received "${value}".`,
      ),
    );
  }

  return new Date(value).toISOString();
};

const printEvent = (event: DeliveryLogEvent): void => {
  console.log(
    `  ${formatBundleTimestamp(event.deliveredAt)}  ${event.track.title} — ` +
      `${event.preset.label} — ${formatBytes(event.bytes)}` +
      `${event.source === "reconciled" ? "  (reconstructed)" : ""}`,
  );
  console.log(`      ${event.path}`);
};

runCli("reading delivery history", async () => {
  const options = parseArgs(process.argv.slice(2));

  if (options.help) {
    printUsage();
    return;
  }

  const settings = await readDeliverySettings();

  if (options.releaseLock) {
    const { root } = await queryDeliveryHistory({ settings, filter: { limit: 1 } });

    if (root === null) {
      throw new TrackError(
        trackIssue("INVALID_REQUEST", "No export destination is configured."),
      );
    }

    const released = await releaseDeliveryLogLock(root);

    if (!released.released) {
      throw new TrackError(
        trackIssue("INVALID_REQUEST", released.problem ?? "The lock was not cleared."),
      );
    }

    console.log(`✓ Cleared the delivery log's append lock.`);
    if (released.problem !== null) console.log(`  ${released.problem}`);
    return;
  }

  if (options.repairTail) {
    const { root } = await queryDeliveryHistory({ settings, filter: { limit: 1 } });

    if (root === null) {
      throw new TrackError(
        trackIssue("INVALID_REQUEST", "No export destination is configured."),
      );
    }

    const repair = await repairDeliveryLogTail(root);

    if (!repair.repaired) {
      throw new TrackError(
        trackIssue("INVALID_REQUEST", repair.problem ?? "Nothing was repaired."),
      );
    }

    console.log(`✓ Dropped an incomplete final line from ${DELIVERY_LOG_FILENAME}.`);
    console.log(`  Discarded: ${JSON.stringify(repair.discarded)}`);
    console.log(`  ${readDeliveryLog(root).events.length} event(s) remain.`);
    return;
  }

  if (options.reconcile) {
    const result = await reconcileDeliveryHistory({ settings });

    if (result.problem !== null) {
      throw new TrackError(trackIssue("INVALID_REQUEST", result.problem));
    }

    console.log(`Destination: ${result.root}\n`);
    console.log(
      `${result.scanned} receipt(s) examined · ${result.alreadyRecorded} already recorded · ` +
        `${result.appended.length} appended · ${result.unreconcilable.length} not reconstructable`,
    );

    for (const event of result.appended) console.log(`  + ${event.track.title} — ${event.preset.label}`);
    for (const skipped of result.unreconcilable) {
      console.log(`  - ${skipped.slug} / ${skipped.presetId}: ${skipped.reason}`);
    }

    if (result.appended.length > 0) {
      // Said plainly, because a reconstructed entry is not a contemporaneous
      // record and a reader should know which ones those are.
      console.log(
        "\nAppended events are marked as reconstructed. Their timestamps and sizes",
        "\ncome from the delivery receipts; their track details are current metadata.",
      );
    }
    return;
  }

  const from = instant(options.since, "--since");
  const to = instant(options.until, "--until");
  const result = await queryDeliveryHistory({
    settings,
    filter: {
      track: options.track ?? null,
      preset: options.preset ?? null,
      from,
      to,
      limit: options.limit,
      order: options.oldest ? "oldest" : "newest",
    },
  });

  if (result.root === null) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        result.rootProblem ??
          'No export destination is configured. Set one with: npm run deliver-track -- --set-root "/Users/you/Movies/Toshi Exports"',
      ),
    );
  }

  console.log(`Destination: ${result.root}\n`);

  const note = DELIVERY_LOG_STATUS_NOTES[result.status];
  if (note !== null) {
    console.log(`! ${note}`);
    for (const problem of result.problems) {
      console.log(`  line ${problem.line}: ${problem.message}`);
    }
    console.log("");
  }

  if (result.status === "missing") {
    console.log("No deliveries have been recorded at this destination yet.");
    return;
  }

  const { summary } = result;
  console.log(
    [
      `${summary.total} recorded`,
      `${summary.today} today`,
      `${summary.last7Days} this week`,
      `${summary.tracksLast7Days} track(s) this week`,
    ].join(" · "),
  );
  if (summary.lastDeliveredAt !== null) {
    console.log(`Last delivery: ${formatBundleTimestamp(summary.lastDeliveredAt)}`);
  }

  console.log(
    `\nShowing ${result.events.length} of ${result.matched} matching event(s):\n`,
  );
  for (const event of result.events) printEvent(event);

  if (options.report) {
    // The report covers the whole selected range, not just the printed page.
    const ranged = selectDeliveryHistory(readDeliveryLog(result.root).events, {
      track: options.track ?? null,
      preset: options.preset ?? null,
      from,
      to,
      limit: DELIVERY_HISTORY_MAX_LIMIT,
      order: "newest",
    });
    const filename = await writeDeliveryReport(result.root, ranged.events, { from, to });

    console.log(`\n✓ Wrote ${filename} (${ranged.events.length} event(s)).`);
    const ranged7 = summarizeDeliveryHistory(ranged.events);
    console.log(`  ${ranged7.total} delivery(ies) across ${ranged7.byTrack.length} track(s).`);
  }
});
