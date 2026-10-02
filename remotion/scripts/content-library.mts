import { formatBundleTimestamp, formatBytes } from "../core/domain/delivery/releaseBundle.ts";
import {
  CONTENT_LIBRARY_MAX_LIMIT,
  CONTENT_LIBRARY_STATUS_NOTES,
  EXPORT_KIND_LABELS,
  LIBRARY_ENTRY_STATUSES,
  LIBRARY_ENTRY_STATUS_LABELS,
  parseContentLibraryQuery,
  type ContentLibraryEntry,
} from "../core/domain/library/contentLibrary.ts";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import { STALE_REASON_LABELS } from "../core/domain/video/exportFreshness.ts";
import { RENDER_PRESET_IDS } from "../core/domain/video/renderPresets.ts";
import {
  contentLibraryPath,
  releaseContentLibraryLock,
  repairContentLibraryTail,
} from "../services/library/contentLibraryLog.ts";
import { adoptExistingExports } from "../services/library/recordExport.ts";
import {
  getContentLibraryRecord,
  queryContentLibrary,
} from "../services/workflows/contentLibrary.ts";
import { runCli } from "./cli.ts";

/**
 * Lists and inspects the content library — every export this project has
 * generated, and which version of each is on disk now.
 *
 * Uses the same query service and the same filter parser as the API, so a
 * filter means the same thing in both places and there is no business logic
 * here. Recording happens automatically on every completed render; nothing
 * here renders, and nothing here rewrites a record.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run content-library [-- <options>]",
      "",
      "  --track <slug>      Only this track",
      `  --preset <id>       Only this format: ${RENDER_PRESET_IDS.join(", ")}`,
      `  --status <status>   Only ${LIBRARY_ENTRY_STATUSES.join(", ")}`,
      "  --kind <kind>       Only original or reexport",
      "  --job <id>          Only what this render job produced",
      "  --since <period>    Generated from 7d, 24h, or an ISO timestamp",
      "  --until <when>      Generated before this ISO timestamp",
      `  --limit <n>         How many to print (default 20, max ${CONTENT_LIBRARY_MAX_LIMIT})`,
      "  --oldest            Oldest first (default is newest first)",
      "  --json              Print JSON instead of text",
      "  --id <record>       Inspect one record, with every version of its format",
      "  --adopt-existing    Record exports already on disk that the library lacks",
      "  --repair-tail       Drop an incomplete final line, and nothing else",
      "  --release-lock      Clear an append lock no live process here holds",
      "",
      "Every completed render records itself here. Nothing here deletes or rewrites a record.",
      "",
      "Examples:",
      "  npm run content-library",
      "  npm run content-library -- --track ghetto-geek",
      "  npm run content-library -- --status superseded --since 30d",
    ].join("\n"),
  );
};

const VALUE_FLAGS = ["--track", "--preset", "--status", "--kind", "--job", "--since", "--until", "--limit", "--id"];

const parseArgs = (argv: string[]) => {
  const valueAfter = (flag: string): string | undefined => {
    const index = argv.indexOf(flag);
    if (index === -1) return undefined;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new TrackError(trackIssue("INVALID_REQUEST", `${flag} needs a value.`));
    }
    return value;
  };

  for (const [index, arg] of argv.entries()) {
    const isValue = index > 0 && VALUE_FLAGS.includes(argv[index - 1]);
    if (isValue) continue;
    if (
      !arg.startsWith("--") ||
      ![...VALUE_FLAGS, "--oldest", "--json", "--adopt-existing", "--repair-tail", "--release-lock", "--help"].includes(arg)
    ) {
      throw new TrackError(trackIssue("INVALID_REQUEST", `Unknown argument "${arg}". Try --help.`));
    }
  }

  return {
    raw: {
      track: valueAfter("--track"),
      preset: valueAfter("--preset"),
      status: valueAfter("--status"),
      kind: valueAfter("--kind"),
      job: valueAfter("--job"),
      since: valueAfter("--since"),
      to: valueAfter("--until"),
      limit: valueAfter("--limit") ?? "20",
      order: argv.includes("--oldest") ? "oldest" : "newest",
    },
    id: valueAfter("--id"),
    json: argv.includes("--json"),
    adopt: argv.includes("--adopt-existing"),
    repairTail: argv.includes("--repair-tail"),
    releaseLock: argv.includes("--release-lock"),
    help: argv.includes("--help"),
  };
};

const kindText = (entry: ContentLibraryEntry): string => {
  const { record } = entry;
  if (record.source === "adopted") return "Adopted";
  if (record.exportKind === "original" || record.exportKind === null) return EXPORT_KIND_LABELS.original;
  const changed = record.replaces?.changed ?? [];
  return changed.length === 0
    ? `${EXPORT_KIND_LABELS.reexport} (no input changes)`
    : `${EXPORT_KIND_LABELS.reexport} — ${changed.map((reason) => STALE_REASON_LABELS[reason]).join(", ")}`;
};

const deliveredText = (entry: ContentLibraryEntry): string =>
  entry.deliveries === null
    ? ""
    : entry.deliveries.count === 0
      ? " · not delivered"
      : ` · delivered ${entry.deliveries.count}×`;

const describe = (entry: ContentLibraryEntry): string => {
  const { record } = entry;
  return (
    `  ${LIBRARY_ENTRY_STATUS_LABELS[entry.status].padEnd(11)}` +
    `${record.track.title} — ${record.preset.label} — ${formatBundleTimestamp(record.generatedAt)}` +
    ` — ${kindText(entry)}${deliveredText(entry)}\n` +
    `             ${record.recordId}  ${record.output.path}`
  );
};

runCli("reading the content library", async () => {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    printUsage();
    return;
  }

  if (args.releaseLock) {
    const result = releaseContentLibraryLock();
    console.log(result.released ? `✓ Cleared the content library lock.${result.problem ? ` ${result.problem}` : ""}` : `! ${result.problem}`);
    return;
  }

  if (args.repairTail) {
    const result = await repairContentLibraryTail();
    if (!result.repaired) throw new TrackError(trackIssue("INVALID_REQUEST", result.problem ?? "Nothing was repaired."));
    console.log(`✓ Dropped an incomplete final line (${result.discarded?.length ?? 0} bytes).`);
    return;
  }

  if (args.adopt) {
    const result = await adoptExistingExports();
    console.log(`✓ Adopted ${result.adopted} existing export(s); ${result.alreadyRecorded} already recorded.`);
    for (const skipped of result.skipped) console.log(`  skipped ${skipped.slug} ${skipped.presetId}: ${skipped.reason}`);
    for (const problem of result.problems) console.log(`  ! ${problem}`);
    return;
  }

  if (args.id !== undefined) {
    const id = parseContentLibraryQuery({ id: args.id }).recordId!;
    const detail = await getContentLibraryRecord(id);
    if (args.json) {
      console.log(JSON.stringify(detail, null, 2));
      return;
    }
    const { record } = detail.entry;
    console.log(`${record.track.title} — ${record.preset.label}`);
    console.log(`  record:      ${record.recordId} (${record.source})`);
    console.log(`  status:      ${LIBRARY_ENTRY_STATUS_LABELS[detail.entry.status]}`);
    console.log(`  generated:   ${formatBundleTimestamp(record.generatedAt)}`);
    console.log(`  kind:        ${kindText(detail.entry)}`);
    console.log(`  render job:  ${record.renderJobId ?? "—"}`);
    console.log(`  output:      ${record.output.path} (${formatBytes(record.output.bytes)})`);
    console.log(`  manifest:    ${record.manifest.path}`);
    console.log(`  fingerprint: ${record.manifest.inputFingerprint}`);
    console.log(`  template:    ${record.template.composition} ${record.template.visualizerVersion}`);
    if (record.replaces) console.log(`  replaces:    ${record.replaces.recordId ?? "an export from before the library"}`);
    if (detail.entry.supersededBy) console.log(`  replaced by: ${detail.entry.supersededBy}`);
    console.log(`  re-export:   ${detail.reexport.allowed ? "available" : detail.reexport.reason}`);
    console.log(`\n  ${detail.versions.length} version(s) of this format, oldest first:`);
    for (const version of detail.versions) console.log(describe(version));
    return;
  }

  const filter = parseContentLibraryQuery(args.raw);
  const result = await queryContentLibrary({ filter });

  if (args.json) {
    console.log(JSON.stringify({ ...result, statusNote: CONTENT_LIBRARY_STATUS_NOTES[result.status] }, null, 2));
    return;
  }

  const note = CONTENT_LIBRARY_STATUS_NOTES[result.status];
  if (note) console.log(`! ${note}\n`);

  if (result.status === "missing") {
    console.log(`Nothing recorded yet (${contentLibraryPath()}).`);
    console.log("Every completed render is recorded automatically; --adopt-existing records what is already on disk.");
    return;
  }

  const { summary } = result;
  console.log(
    `${summary.total} version(s) of ${summary.tracks} track(s) · ` +
      LIBRARY_ENTRY_STATUSES.map((status) => `${summary.byStatus[status]} ${status}`).join(" · "),
  );

  if (result.formats) {
    console.log("");
    for (const format of result.formats) {
      console.log(
        `  ${format.label.padEnd(14)}` +
          (format.versions === 0
            ? "never generated"
            : `${format.versions} version(s) · latest ${formatBundleTimestamp(format.latestGeneratedAt!)} · ${LIBRARY_ENTRY_STATUS_LABELS[format.latestStatus!]}`),
      );
    }
  }

  console.log(`\nShowing ${result.entries.length} of ${result.matched}:`);
  for (const entry of result.entries) console.log(describe(entry));
});
