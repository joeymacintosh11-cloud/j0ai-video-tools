import {
  classifyRecoveredJob,
  isSeriousJournalDamage,
  reconstructRenderJournal,
} from "../src/domain/render/renderJournal.ts";
import {
  compactRenderJournal,
  readRenderJournal,
  RENDER_JOURNAL_DIR,
  repairRenderJournalTail,
} from "../services/render/renderJournalLog.ts";
import { RENDER_MANAGER_BOOT_ID } from "../server/services/renderJournal.ts";
import { TrackError, trackIssue } from "../src/domain/tracks/errors.ts";
import { runCli } from "./cli.ts";

/**
 * A small diagnostic over the durable render journal — never a second way to
 * start, cancel or resume a render. Reads only; `--compact` and
 * `--repair-tail` are the one exception, and both only ever remove
 * already-superseded or already-unparseable bytes, never a live fact.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run render-journal [-- <options>]",
      "",
      "  --job <id>      Show what the journal knows about one job",
      "  --recent        List every job the journal currently tracks",
      "  --compact       Drop superseded history for settled jobs (retention)",
      "  --repair-tail   Drop an incomplete final line, and nothing else",
      "",
      `Journal location: ${RENDER_JOURNAL_DIR}/journal.jsonl (machine-local, never committed).`,
      "",
      "Examples:",
      "  npm run render-journal -- --recent",
      "  npm run render-journal -- --job 5b1c...",
    ].join("\n"),
  );
};

const parseArgs = (argv: string[]) => {
  const jobIndex = argv.indexOf("--job");
  const jobId = jobIndex === -1 ? undefined : argv[jobIndex + 1];
  if (jobIndex !== -1 && (jobId === undefined || jobId.startsWith("--"))) {
    throw new TrackError(trackIssue("INVALID_REQUEST", "--job needs a job id."));
  }

  return {
    help: argv.includes("--help") || argv.includes("-h"),
    jobId,
    recent: argv.includes("--recent"),
    compact: argv.includes("--compact"),
    repairTail: argv.includes("--repair-tail"),
  };
};

runCli("inspecting the render journal", async () => {
  const { help, jobId, recent, compact, repairTail } = parseArgs(process.argv.slice(2));

  if (help || (!jobId && !recent && !compact && !repairTail)) {
    printUsage();
    return;
  }

  if (repairTail) {
    const result = await repairRenderJournalTail();
    if (result.repaired) {
      console.log(`✓ Dropped an incomplete final line (${result.discarded?.length ?? 0} bytes).`);
    } else {
      console.log(result.problem ?? "Nothing to repair.");
    }
    return;
  }

  if (compact) {
    const result = await compactRenderJournal();
    if (result.problem) {
      console.log(result.problem);
    } else if (result.compacted) {
      console.log(`✓ Compacted ${result.before} events down to ${result.after}.`);
    } else {
      console.log(`Nothing to compact (${result.before} events, all still within retention).`);
    }
    return;
  }

  const read = readRenderJournal();

  if (read.status === "missing") {
    console.log("No render journal yet — nothing has queued a render since this journal existed.");
    return;
  }

  console.log(`Journal status: ${read.status} (${read.events.length} events, ${read.lines} lines)`);
  if (isSeriousJournalDamage(read.status)) {
    console.log("  This journal has damage this tool will not silently work around. Inspect it directly.");
  }
  for (const problem of read.problems) {
    console.log(`  line ${problem.line}: ${problem.kind} — ${problem.message}`);
  }

  const { jobs, quarantined } = reconstructRenderJournal(read.events);
  for (const { event, reason } of quarantined) {
    console.log(`  quarantined event ${event.eventId}: ${reason}`);
  }

  if (jobId) {
    const record = jobs.get(jobId);
    if (!record) {
      console.log(`\nNo journal record for job ${jobId}.`);
      return;
    }
    const recovered = classifyRecoveredJob(record, RENDER_MANAGER_BOOT_ID);
    console.log(`\nJob ${recovered.jobId}`);
    console.log(`  slug:                   ${recovered.slug}`);
    console.log(`  preset:                 ${recovered.presetId}`);
    console.log(`  batch:                  ${recovered.batchId ?? "(none)"}`);
    console.log(`  status:                 ${recovered.status}`);
    console.log(`  last recorded:          ${recovered.recordedAt}`);
    console.log(`  recovered after restart: ${recovered.recoveredAfterRestart}`);
    if (recovered.error) console.log(`  error:                  ${recovered.error.code}: ${recovered.error.message}`);
    return;
  }

  if (recent) {
    console.log(`\n${jobs.size} job${jobs.size === 1 ? "" : "s"} tracked:`);
    for (const record of [...jobs.values()].sort(
      (a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt),
    )) {
      const recovered = classifyRecoveredJob(record, RENDER_MANAGER_BOOT_ID);
      console.log(
        `  [${recovered.status}] ${recovered.slug} / ${recovered.presetId} — ${recovered.jobId} — ${recovered.recordedAt}`,
      );
    }
  }
});
