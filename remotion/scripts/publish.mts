import { publishDestinations } from "../adapters/publishDestinations.mts";
import type { PublishPlanView } from "../core/domain/api/views.ts";
import { resolveMetadataTemplates } from "../core/domain/content/metadataTemplates.ts";
import { buildPlatformMetadata } from "../core/domain/content/platformMetadata.ts";
import { platformsForPreset } from "../core/domain/content/platformProfiles.ts";
import { PUBLISH_PROBLEM_LABELS } from "../core/domain/publishing/publishProblems.ts";
import {
  seedPublicationMetadata,
  type PublicationMetadata,
} from "../core/domain/publishing/publicationMetadata.ts";
import type { PublicationReceipt } from "../core/domain/publishing/publicationReceipt.ts";
import type { PublishJob } from "../core/domain/publishing/publishJob.ts";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../core/domain/tracks/slug.ts";
import { assertRenderPresetId, DEFAULT_RENDER_PRESET_ID } from "../core/domain/video/renderPresets.ts";
import {
  isRendererId,
  RENDERER_IDS,
  RENDERER_LABELS,
  resolveTrackRenderer,
  type RendererId,
} from "../core/domain/video/renderers.ts";
import { readContentMetadataSettings } from "../services/content/metadataTemplateSettings.ts";
import { createPublishingService } from "../services/publishing/publishing.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { runCli } from "./cli.ts";

/**
 * Publishing from the terminal — for development and testing.
 *
 *   npm run publish-destinations
 *   npm run publish-plan    -- <slug> --destination local-mock [--format youtube-16x9] [--renderer remotion]
 *   npm run publish-track   -- <slug> --destination local-mock [...same...] [--title ..] [--tag ..]...
 *   npm run publish-track   -- --job <id> --retry | --cancel | --recover
 *   npm run publish-history [-- --track <slug>] [--destination <id>] [--jobs] [--json]
 *
 * Uses the same services and destination registry as the API. Only local
 * destinations exist in this milestone; nothing here touches a network.
 * The renderer defaults to the track's saved preference and is always printed,
 * because a publication names one renderer's export exactly.
 */

const USAGE = [
  "Usage:",
  "  npm run publish-destinations [-- --json]",
  "  npm run publish-plan  -- <track-slug> --destination <id> [options]",
  "  npm run publish-track -- <track-slug> --destination <id> [options]",
  "  npm run publish-track -- --job <job-id> (--retry | --cancel | --recover)",
  "  npm run publish-history [-- --track <slug>] [--destination <id>] [--jobs] [--json]",
  "",
  "Options:",
  "  --format <preset>       Export format to publish (default youtube-16x9)",
  `  --renderer <id>         Whose export (${RENDERER_IDS.join(", ")}); default: the track's saved preference`,
  "  --title <text>          Publication title (default: from the content package's metadata)",
  "  --description <text>    Description or caption",
  "  --tag <tag>             Repeatable; replaces the default tags",
  "  --visibility <v>        public, unlisted or private (default private)",
  "  --account <id>          Account/profile identifier, when the destination has several",
  "  --json                  Print JSON",
].join("\n");

const FLAGS_WITH_VALUES = new Set(["--destination", "--format", "--renderer", "--title", "--description", "--tag", "--visibility", "--account", "--job", "--track", "--mode"]);

const parse = (argv: readonly string[]) => {
  const values = new Map<string, string[]>();
  const positional: string[] = [];
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (FLAGS_WITH_VALUES.has(arg)) {
      const value = argv[i + 1];
      if (value === undefined || (value.startsWith("--") && value !== "--"))
        throw new TrackError(trackIssue("INVALID_REQUEST", `${arg} needs a value.`));
      values.set(arg, [...(values.get(arg) ?? []), value]);
      i++;
    } else if (arg.startsWith("--")) flags.add(arg);
    else positional.push(arg);
  }
  const one = (flag: string) => values.get(flag)?.at(-1);
  return { values, positional, flags, one };
};

const printProblems = (problems: PublishPlanView["problems"]) => {
  for (const problem of problems) console.log(`  ✗ ${PUBLISH_PROBLEM_LABELS[problem.reason]}${problem.field ? ` (${problem.field})` : ""}: ${problem.message}`);
};

const printReceipt = (receipt: PublicationReceipt) => {
  console.log(`  ✓ ${receipt.destination.id}${receipt.destination.accountId ? ` as ${receipt.destination.accountId}` : ""}: ${receipt.publicationId}`);
  if (receipt.url) console.log(`    url:      ${receipt.url}`);
  console.log(`    source:   ${receipt.source.outputLabel} (${RENDERER_LABELS[receipt.source.renderer]}, ${receipt.source.presetId}, fingerprint ${receipt.source.inputFingerprint.slice(0, 12)})`);
  console.log(`    title:    ${receipt.metadata.title}`);
  console.log(`    at:       ${receipt.publishedAt}   receipt ${receipt.receiptId}`);
};

const printJob = (job: PublishJob & { receipt: PublicationReceipt | null }) => {
  console.log(`\n${job.jobId}  ${job.state}  (${job.certainty.replace("_", " ")})`);
  console.log(`  ${job.destinationId} ← ${job.sourceRef.slug} / ${job.sourceRef.presetId} / ${RENDERER_LABELS[job.sourceRef.renderer]}`);
  console.log(`  attempts: ${job.attempts.length}${job.attempts.length ? ` (last: ${job.attempts.at(-1)!.outcome ?? "in progress"})` : ""}`);
  printProblems(job.problems);
  if (job.receipt) printReceipt(job.receipt);
};

/** Default metadata: the content package's copy for the platform that uses this format. */
const defaultMetadata = async (slug: string, presetId: ReturnType<typeof assertRenderPresetId>): Promise<PublicationMetadata> => {
  const inspection = await inspectTrack(slug);
  const platform = platformsForPreset(presetId)[0];
  if (inspection.metadata === null || platform === undefined)
    return seedPublicationMetadata({ title: null, description: null, caption: null, keywords: null, hashtags: null }, slug);
  const { settings } = await readContentMetadataSettings();
  const templates = resolveMetadataTemplates(settings.templates, inspection.metadata.contentMetadataOverrides);
  return seedPublicationMetadata(buildPlatformMetadata(slug, platform, inspection.metadata, templates), inspection.metadata.title);
};

const main = async () => {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const args = parse(argv.slice(1));
  const json = args.flags.has("--json");
  if (args.flags.has("--help")) {
    console.log(USAGE);
    return;
  }
  const publishing = createPublishingService(publishDestinations, { log: (message) => console.log(`  · ${message}`) });

  if (command === "--destinations") {
    const view = publishing.destinations();
    if (json) return void console.log(JSON.stringify(view, null, 2));
    if (view.settingsProblem) console.log(`! ${view.settingsProblem}`);
    for (const destination of view.destinations) {
      const formats = destination.capabilities?.formats.map((f) => `${f.presetId}→${f.mode}`).join(", ") ?? "—";
      console.log(`${destination.state === "ready" ? "✓" : "✗"} ${destination.id.padEnd(22)} ${destination.state.padEnd(15)} ${destination.displayName}`);
      console.log(`    formats: ${formats}${destination.accountId ? `   account: ${destination.accountId}` : ""}`);
      if (destination.problem) console.log(`    ${destination.problem}`);
    }
    return;
  }

  if (command === "--history") {
    const track = args.one("--track");
    const destination = args.one("--destination");
    if (args.flags.has("--jobs")) {
      const jobs = await publishing.listJobs({ ...(track ? { track: assertValidSlug(track) } : {}), ...(destination ? { destination } : {}) });
      if (json) return void console.log(JSON.stringify(jobs, null, 2));
      if (jobs.jobs.length === 0) console.log("No publish jobs.");
      jobs.jobs.forEach(printJob);
      for (const problem of jobs.problems) console.log(`! ${problem.file}: ${problem.message}`);
      return;
    }
    const history = publishing.history({ ...(track ? { track: assertValidSlug(track) } : {}), ...(destination ? { destination } : {}), limit: 100 });
    if (json) return void console.log(JSON.stringify(history, null, 2));
    if (history.receipts.length === 0) console.log("No publications recorded.");
    history.receipts.forEach(printReceipt);
    for (const problem of history.problems) console.log(`! receipts.jsonl line ${problem.line}: ${problem.message}`);
    return;
  }

  if (command !== "--plan" && command !== "--publish") {
    console.error(USAGE);
    process.exit(1);
  }

  const jobId = args.one("--job");
  if (jobId !== undefined) {
    if (command !== "--publish") throw new TrackError(trackIssue("INVALID_REQUEST", "--job is only for publish-track."));
    const job = args.flags.has("--cancel") ? await publishing.cancel(jobId)
      : args.flags.has("--recover") ? await publishing.recover(jobId)
      : args.flags.has("--retry") ? await publishing.execute(jobId)
      : await publishing.getJob(jobId);
    if (json) return void console.log(JSON.stringify(job, null, 2));
    printJob(job);
    if ("recovery" in job) console.log(`  ${job.recovery}`);
    return;
  }

  const slug = assertValidSlug(args.positional[0]);
  const destinationId = args.one("--destination");
  if (destinationId === undefined) throw new TrackError(trackIssue("INVALID_REQUEST", `--destination is required. See: npm run publish-destinations\n\n${USAGE}`));
  const presetId = assertRenderPresetId(args.one("--format") ?? DEFAULT_RENDER_PRESET_ID);
  const rendererFlag = args.one("--renderer");
  if (rendererFlag !== undefined && !isRendererId(rendererFlag))
    throw new TrackError(trackIssue("INVALID_RENDERER", `--renderer must be one of ${RENDERER_IDS.join(", ")}.`));
  const renderer: RendererId = rendererFlag ?? resolveTrackRenderer((await inspectTrack(slug)).metadata?.renderer);
  const seeded = await defaultMetadata(slug, presetId);
  const metadata = {
    ...seeded,
    ...(args.one("--title") === undefined ? {} : { title: args.one("--title") }),
    ...(args.one("--description") === undefined ? {} : { description: args.one("--description") }),
    ...(args.values.has("--tag") ? { tags: args.values.get("--tag") } : {}),
    ...(args.one("--visibility") === undefined ? {} : { visibility: args.one("--visibility") }),
  };
  const input = { destinationId, source: { slug, presetId, renderer }, metadata, accountId: args.one("--account") ?? null };

  if (!json) console.log(`→ ${slug} / ${presetId} / ${RENDERER_LABELS[renderer]} export → ${destinationId}`);
  if (command === "--plan") {
    const plan = await publishing.plan(input);
    if (json) return void console.log(JSON.stringify(plan, null, 2));
    console.log(`  source:   ${plan.sourceStatus.outputLabel} (${plan.sourceStatus.freshness})`);
    if (plan.metadata) console.log(`  title:    ${plan.metadata.title}\n  tags:     ${plan.metadata.tags.join(", ") || "—"}\n  mode:     ${plan.mode ?? "—"}`);
    if (plan.ok) console.log("✓ Ready to publish. Nothing was published (plan only).");
    else {
      printProblems(plan.problems);
      process.exitCode = 1;
    }
    return;
  }

  const created = await publishing.createJob(input);
  const job = created.state === "ready" ? await publishing.execute(created.jobId) : created;
  if (json) return void console.log(JSON.stringify(job, null, 2));
  printJob(job);
  if (job.state !== "published") process.exitCode = 1;
};

runCli("publishing", main);
