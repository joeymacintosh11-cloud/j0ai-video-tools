import type {
  ContentPackageMode,
  ContentPackagePlatformEntry,
  ContentPackageStatus,
  ContentPackageView,
  PlatformAction,
  PlatformReadiness,
} from "./contentPackage.ts";
import type { StaleReason } from "../video/exportFreshness.ts";
import type { RenderPresetId } from "../video/renderPresets.ts";
import type { PlatformId } from "./platformProfiles.ts";

/**
 * A live, aggregated view over several tracks' content packages — never
 * persisted, exactly like a single package (see contentPackage.ts). Nothing
 * here computes readiness itself: every per-track answer is whatever
 * `deriveContentPackage` already said, so a batch can never disagree with the
 * single-track view of the same track.
 *
 * Pure and browser-safe. The server (or the CLI) does the I/O — inspecting
 * each track, gathering export/queue/delivery state — and hands this module
 * an array of already-derived `ContentPackageView`s to aggregate.
 */

export type BatchTrackEntry = {
  readonly slug: string;
  readonly title: string | null;
  readonly packageStatus: ContentPackageStatus;
  readonly platforms: readonly ContentPackagePlatformEntry[];
  readonly readyCount: number;
  readonly missingCount: number;
  readonly staleCount: number;
  readonly renderingCount: number;
  readonly blockedCount: number;
  /** Always true today — every track passed in was explicitly selected. */
  readonly selected: boolean;
  /** The distinct platform-level actions available anywhere in this track. */
  readonly availableActions: readonly PlatformAction[];
};

/** A requested track that could not be inspected at all (not found, etc). */
export type BatchInvalidTrackEntry = {
  readonly slug: string;
  readonly reason: string;
};

export type BatchContentPackageTotals = {
  readonly tracks: number;
  /** Track-level counts — each track has exactly one packageStatus. */
  readonly complete: number;
  readonly incomplete: number;
  readonly stale: number;
  readonly blocked: number;
  /**
   * Platform-target-level counts from here down — summed across every
   * selected platform on every track, not a track-status count. "rendering"
   * has no packageStatus equivalent (see ContentPackageStatus), which is why
   * it sits with the target sums rather than the four status counts above.
   */
  readonly rendering: number;
  readonly totalPlatformTargets: number;
  readonly readyTargets: number;
  readonly missingTargets: number;
  readonly staleTargets: number;
};

export type BatchContentPackageView = {
  readonly inspectedAt: string;
  readonly mode: ContentPackageMode;
  readonly tracks: readonly BatchTrackEntry[];
  /** Requested tracks that do not exist or could not be inspected. */
  readonly invalid: readonly BatchInvalidTrackEntry[];
  /** Requested slugs repeated more than once, de-duplicated before inspecting. */
  readonly duplicates: readonly string[];
  readonly totals: BatchContentPackageTotals;
};

export type DeriveBatchContentPackageOptions = {
  readonly invalid?: readonly BatchInvalidTrackEntry[];
  readonly duplicates?: readonly string[];
  /** Injectable clock, so tests can assert a byte-identical view. */
  readonly now?: () => string;
};

/** Aggregates already-derived per-track packages — reuses, never recomputes, readiness. */
export const deriveBatchContentPackage = (
  packages: readonly ContentPackageView[],
  options: DeriveBatchContentPackageOptions = {},
): BatchContentPackageView => {
  const now = options.now ?? (() => new Date().toISOString());

  const tracks: BatchTrackEntry[] = packages.map((pkg) => ({
    slug: pkg.slug,
    title: pkg.title,
    packageStatus: pkg.packageStatus,
    platforms: pkg.platforms,
    readyCount: pkg.counts.ready,
    missingCount: pkg.counts.missing,
    staleCount: pkg.counts.stale,
    renderingCount: pkg.counts.rendering,
    blockedCount: pkg.counts.blocked,
    selected: true,
    availableActions: Array.from(
      new Set(pkg.platforms.flatMap((platform) => platform.actions)),
    ),
  }));

  const sum = (pick: (entry: BatchTrackEntry) => number): number =>
    tracks.reduce((total, entry) => total + pick(entry), 0);

  const totals: BatchContentPackageTotals = {
    tracks: tracks.length,
    complete: tracks.filter((t) => t.packageStatus === "complete").length,
    incomplete: tracks.filter((t) => t.packageStatus === "incomplete").length,
    stale: tracks.filter((t) => t.packageStatus === "stale").length,
    blocked: tracks.filter((t) => t.packageStatus === "blocked").length,
    rendering: sum((t) => t.renderingCount),
    totalPlatformTargets: packages.reduce(
      (total, pkg) => total + pkg.counts.selected,
      0,
    ),
    readyTargets: sum((t) => t.readyCount),
    missingTargets: sum((t) => t.missingCount),
    staleTargets: sum((t) => t.staleCount),
  };

  return {
    inspectedAt: now(),
    mode: packages[0]?.mode ?? "intent",
    tracks,
    invalid: options.invalid ?? [],
    duplicates: options.duplicates ?? [],
    totals,
  };
};

/* ------------------------------------------------------------------ *
 * Planning: platform readiness -> what a batch apply would do
 *
 * Pure, like the rest of this module: it only re-labels the readiness
 * `deriveContentPackage` already computed for each platform, so a plan can
 * never disagree with the package view it was built from. The caller (a
 * server route or the CLI) is the one with I/O: gathering each track's
 * ContentPackageView, and afterwards turning `renderable` into real render
 * targets via the existing render manager/queue — never a second one.
 * ------------------------------------------------------------------ */

export type ContentPackageActionKind =
  | "render_missing"
  | "rerender_stale"
  | "adopt_existing_render"
  | "already_ready"
  | "blocked";

export type ContentPackagePlannedAction = {
  readonly slug: string;
  readonly platformId: PlatformId;
  readonly presetId: RenderPresetId;
  readonly label: string;
  readonly kind: ContentPackageActionKind;
  readonly staleReasons: readonly StaleReason[];
  readonly reason: string | null;
};

export type ContentPackageBatchPlan = {
  readonly mode: ContentPackageMode;
  readonly tracks: number;
  /** Every selected platform considered, across every found track. */
  readonly actions: readonly ContentPackagePlannedAction[];
  /** render_missing/rerender_stale actions, de-duplicated by track+preset. */
  readonly renderable: readonly ContentPackagePlannedAction[];
  readonly adopted: readonly ContentPackagePlannedAction[];
  readonly ready: readonly ContentPackagePlannedAction[];
  readonly blocked: readonly ContentPackagePlannedAction[];
  readonly invalid: readonly BatchInvalidTrackEntry[];
  readonly duplicates: readonly string[];
};

/** One content package per requested track, found or not — the planner's input. */
export type ContentPackageBatchTrack =
  | { readonly slug: string; readonly found: true; readonly package: ContentPackageView }
  | { readonly slug: string; readonly found: false; readonly reason: string };

const kindFor = (readiness: PlatformReadiness): ContentPackageActionKind | null => {
  switch (readiness) {
    case "missing":
      return "render_missing";
    case "stale":
      return "rerender_stale";
    case "rendering":
      return "adopt_existing_render";
    case "ready":
      return "already_ready";
    case "blocked":
      return "blocked";
    case "not_selected":
      return null;
  }
};

const blockerReasonFor = (platform: ContentPackagePlatformEntry): string =>
  platform.blockers[0] ?? "Track is not currently renderable.";

/**
 * Turns each track's already-derived package into a flat action list.
 *
 * `kindFor` is a one-to-one mapping off `PlatformReadiness`, the same enum
 * `deriveContentPackage` already computed — nothing here re-decides
 * readiness. Deduplication only affects `renderable`: two platforms that
 * happen to share one preset (see platformsForPreset) must still produce
 * exactly one render, never two queued for the same file.
 */
export const planContentPackageBatch = (
  results: readonly ContentPackageBatchTrack[],
  extra: { readonly duplicates?: readonly string[] } = {},
): ContentPackageBatchPlan => {
  const actions: ContentPackagePlannedAction[] = [];
  const invalid: BatchInvalidTrackEntry[] = [];
  let mode: ContentPackageMode = "intent";

  for (const result of results) {
    if (!result.found) {
      invalid.push({ slug: result.slug, reason: result.reason });
      continue;
    }

    mode = result.package.mode;

    for (const platform of result.package.platforms) {
      if (!platform.selected) continue;

      const kind = kindFor(platform.readiness);
      if (kind === null) continue;

      actions.push({
        slug: result.slug,
        platformId: platform.platformId,
        presetId: platform.presetId,
        label: platform.label,
        kind,
        staleReasons: platform.staleReasons,
        reason: kind === "blocked" ? blockerReasonFor(platform) : null,
      });
    }
  }

  const seenTargets = new Set<string>();
  const renderable: ContentPackagePlannedAction[] = [];
  for (const action of actions) {
    if (action.kind !== "render_missing" && action.kind !== "rerender_stale") {
      continue;
    }
    const key = `${action.slug}::${action.presetId}`;
    if (seenTargets.has(key)) continue;
    seenTargets.add(key);
    renderable.push(action);
  }

  return {
    mode,
    tracks: results.length,
    actions,
    renderable,
    adopted: actions.filter((a) => a.kind === "adopt_existing_render"),
    ready: actions.filter((a) => a.kind === "already_ready"),
    blocked: actions.filter((a) => a.kind === "blocked"),
    invalid,
    duplicates: extra.duplicates ?? [],
  };
};

/** The renderable actions, in the shape renderManager.startBatch takes. */
export const toRenderTargetsFromPlan = (
  plan: ContentPackageBatchPlan,
): readonly { readonly slug: string; readonly preset: RenderPresetId }[] =>
  plan.renderable.map((action) => ({
    slug: action.slug,
    preset: action.presetId,
  }));
