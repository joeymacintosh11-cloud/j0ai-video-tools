import { renderEngines } from "../adapters/renderEngines.mts";
import {
  deriveContentPackage,
  type ContentPackageInput,
  type ContentPackageView,
} from "../core/domain/content/contentPackage.ts";
import { assertPlatformId, type PlatformId } from "../core/domain/content/platformProfiles.ts";
import { canonicalPresetOrder, resolveExportPresets } from "../core/domain/video/renderPresets.ts";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import {
  planMissingExports,
  type ExportPlan,
} from "../services/workflows/exportPlan.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
} from "../services/delivery/deliverySettings.ts";
import { readContentMetadataSettings } from "../services/content/metadataTemplateSettings.ts";
import { deliveryStateForTarget } from "../services/delivery/deliverExport.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { renderTrackVideo } from "../services/render/renderTrackVideo.ts";
import { prepareTrack } from "../services/tracks/prepareTrack.ts";
import { runCli, printLibraryOutcome } from "./cli.ts";

/**
 * Inspects, and optionally builds, a track's content package: the
 * platform-facing view of its YouTube/Reels/Instagram outputs.
 *
 * Uses the same planner as the API (`planMissingExports`) and the same
 * render call as `render-missing.mts` — this is not a second rendering
 * system, only a platform-scoped preset selection on top of the existing
 * one. Default behaviour is inspection only; nothing is rendered unless
 * `--apply` is given.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run content-package -- <track-slug> [--mode intent|full] [--platform <id>]... [--json] [--apply]",
      "",
      "  <track-slug>      Folder name under public/tracks/, e.g. ghetto-geek",
      "  --mode <mode>     intent (default, each platform the track already",
      "                    declares) or full (every platform: youtube, reels,",
      "                    instagram-square)",
      "  --platform <id>   Restrict to this platform; repeatable. Overrides --mode.",
      "  --json            Print the package as JSON instead of text",
      "  --apply           Render this package's missing/stale outputs",
      "",
      "With no --apply, this only inspects and reports — nothing is rendered.",
      "",
      "Examples:",
      "  npm run content-package -- ghetto-geek",
      "  npm run content-package -- ghetto-geek --mode full --json",
      "  npm run content-package -- ghetto-geek --apply",
    ].join("\n"),
  );
};

const parseArgs = (argv: string[]) => {
  const modeIndex = argv.indexOf("--mode");
  const modeValue = modeIndex === -1 ? undefined : argv[modeIndex + 1];
  if (modeIndex !== -1 && modeValue === undefined) {
    throw new TrackError(trackIssue("INVALID_REQUEST", "--mode needs a value."));
  }
  if (modeValue !== undefined && modeValue !== "intent" && modeValue !== "full") {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", '--mode must be "intent" or "full".'),
    );
  }

  const platforms: PlatformId[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--platform") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new TrackError(
          trackIssue("INVALID_REQUEST", "--platform needs a value."),
        );
      }
      platforms.push(assertPlatformId(value));
    }
  }

  const positional = argv.filter(
    (arg, index) =>
      !arg.startsWith("--") &&
      !(index > 0 && argv[index - 1] === "--mode") &&
      !(index > 0 && argv[index - 1] === "--platform"),
  );

  return {
    slug: positional[0],
    mode: (modeValue ?? "intent") as "intent" | "full",
    platforms: platforms.length > 0 ? platforms : undefined,
    json: argv.includes("--json"),
    apply: argv.includes("--apply"),
  };
};

const buildPackage = async (
  slug: string,
  mode: "intent" | "full",
  platforms: readonly PlatformId[] | undefined,
): Promise<ContentPackageView> => {
  const inspection = await inspectTrack(slug);

  if (!inspection.facts.trackDirExists) {
    throw new TrackError(
      trackIssue("TRACK_NOT_FOUND", `Track "${slug}" not found.`, `public/tracks/${slug}/`),
    );
  }

  const settings = await readDeliverySettings();
  const { root } = resolveDeliveryRoot(settings);
  const coverage = trackExportCoverage(slug, inspection.metadata);
  const intended = new Set(resolveExportPresets(inspection.metadata?.exportPresets));

  const input: ContentPackageInput = {
    slug,
    title: inspection.metadata?.title ?? inspection.metadataDraft?.title ?? null,
    validationOk: inspection.validation.ok,
    metadata: inspection.metadata,
    contentMetadataOverrides: inspection.metadata?.contentMetadataOverrides,
    exports: coverage.map((facts) => ({
      presetId: facts.presetId,
      status: facts.freshness,
      staleReasons: facts.staleReasons,
      intended: intended.has(facts.presetId),
      delivery: deliveryStateForTarget(
        slug,
        facts.presetId,
        facts,
        inspection.metadata === null ? null : root,
        inspection.metadata?.deliveryFolder,
      ),
    })),
  };

  const { settings: templateSettings, problem: templatesProblem } =
    await readContentMetadataSettings();

  return deriveContentPackage(input, {
    mode,
    platforms,
    globalTemplates: templateSettings.templates,
    templatesProblem,
  });
};

const describe = (pkg: ContentPackageView): void => {
  console.log(`${pkg.title ?? pkg.slug} — ${pkg.packageStatus} (${pkg.mode})`);
  console.log(
    `${pkg.counts.ready}/${pkg.counts.selected} ready · ${pkg.counts.missing} missing · ` +
      `${pkg.counts.stale} stale · ${pkg.counts.rendering} rendering · ${pkg.counts.blocked} blocked`,
  );
  if (pkg.templatesProblem) {
    console.log(`! ${pkg.templatesProblem}`);
  }
  for (const platform of pkg.platforms) {
    const marker = platform.selected ? " " : "◦";
    console.log(`  ${marker} ${platform.label.padEnd(16)} ${platform.readiness.padEnd(12)} ${platform.outputFilename}`);
    if (platform.title) console.log(`      title:    ${platform.title}`);
    if (platform.caption) console.log(`      caption:  ${platform.caption}`);
    if (platform.hashtags?.length) console.log(`      hashtags: ${platform.hashtags.join(" ")}`);
  }
};

const describeBuildPlan = (plan: ExportPlan): void => {
  const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
  console.log(
    [plural(plan.tracks, "track"), `${plan.current.length} current`, `${plan.stale.length} stale`, `${plan.missing.length} missing`].join(" · "),
  );
  for (const target of plan.selected) {
    console.log(`  → ${target.outputLabel}`);
  }
};

runCli("inspecting content package", async () => {
  const { slug, mode, platforms, json, apply } = parseArgs(process.argv.slice(2));

  if (!slug) {
    printUsage();
    process.exit(1);
  }

  const pkg = await buildPackage(slug, mode, platforms);

  if (json) {
    console.log(JSON.stringify(pkg, null, 2));
  } else {
    describe(pkg);
  }

  if (!apply) {
    if (!json) console.log(`\n✓ Inspection only — nothing rendered. Add --apply to build.`);
    return;
  }

  const presetIds = canonicalPresetOrder(
    pkg.platforms.filter((platform) => platform.selected).map((platform) => platform.presetId),
  );

  const plan = await planMissingExports({
    mode: "missing-and-stale",
    slugs: [slug],
    presetIds,
  });

  if (!json) {
    console.log("");
    describeBuildPlan(plan);
  }

  if (plan.selected.length === 0) {
    console.log(`\n✓ Package already complete — nothing to render.`);
    return;
  }

  const { props } = await prepareTrack(slug);

  for (const [index, target] of plan.selected.entries()) {
    console.log(
      `\n→ [${index + 1}/${plan.selected.length}] ${target.slug} — ${target.label}`,
    );

    let lastLoggedPercentage = -1;

    const { outputLabel } = await renderTrackVideo({
      engine: await renderEngines.resolve(undefined),
      slug: target.slug,
      props,
      onRecorded: printLibraryOutcome,
      presetId: target.presetId,
      onDelivery: (outcome) => {
        console.log(
          outcome.status === "delivered"
            ? `✓ Delivered to ${outcome.destinationRelativePath}`
            : `! Not delivered: ${outcome.message ?? outcome.status}`,
        );
      },
      onProgress: ({ progress }) => {
        const percentage = Math.floor(progress * 100);
        if (percentage !== lastLoggedPercentage && percentage % 10 === 0) {
          lastLoggedPercentage = percentage;
          console.log(`  ${percentage}%`);
        }
      },
    });

    console.log(`✓ Rendered ${outputLabel}`);
  }

  console.log(`\n✓ Built ${plan.selected.length} export(s) for this package.`);
});
