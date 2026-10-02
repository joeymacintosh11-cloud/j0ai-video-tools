import type { ExportFreshness, StaleReason } from "../video/exportFreshness.ts";
import type { DeliveryReason, DeliveryStatus } from "../delivery/deliveryPaths.ts";
import type { RenderPresetId } from "../video/renderPresets.ts";
import {
  buildPlatformMetadata,
  type PlatformMetadataSubject,
} from "./platformMetadata.ts";
import {
  resolveMetadataTemplates,
  type PartialMetadataTemplates,
} from "./metadataTemplates.ts";
import {
  canonicalPlatformOrder,
  PLATFORM_LIST,
  platformFilename,
  type PlatformId,
} from "./platformProfiles.ts";

/**
 * One track's platform-facing content package, derived — never persisted.
 *
 * A package answers "for this beat, what do I need for YouTube, Reels/TikTok
 * and Instagram, what is ready, what is stale or missing, and what metadata
 * accompanies it" by composing facts the app already computes elsewhere:
 * export coverage/freshness (§36–38 of the handoff), queue state, delivery
 * state (§39) — never a second source of truth. There is deliberately no
 * "package complete" flag written anywhere; every call re-derives the answer
 * from the same per-format state the track detail view already reports, so a
 * package can never be shown as complete after a file changes underneath it.
 *
 * Pure and browser-safe, exactly like renderPresets.ts and releaseBundle.ts:
 * the server maps a TrackDetailView's `exports` into `PackageExportEntry[]`
 * once, and this module does the rest, so the API and the UI (for a cheap
 * catalogue-row badge, with no extra fetch) derive the same answer from the
 * same inputs.
 */

/**
 * The subset of a RenderOutputView (core/domain/api/views.ts) a package needs.
 * A structural subset rather than an import of that type, so this module has
 * no dependency on the API view layer — views.ts depends on this module, not
 * the reverse, exactly like every other domain/api relationship here.
 */
export type PackageExportEntry = {
  readonly presetId: RenderPresetId;
  readonly status: ExportFreshness | "queued" | "rendering";
  readonly staleReasons: readonly StaleReason[];
  readonly intended: boolean;
  readonly delivery: {
    readonly status: DeliveryStatus;
    /**
     * Optional: every real caller (server/routes/contentPackage.ts) passes a
     * TrackDetailView's own RenderOutputView[] straight through as this
     * type, and that view's own `delivery` already carries `reason` and
     * `deliveredAt` (core/domain/api/views.ts's DeliveryTargetStateView) — this
     * was simply never declared here before there was a reason to read it.
     * Optional rather than required so a caller that only ever had the
     * narrower shape (a hand-built test fixture, say) still type-checks.
     */
    readonly reason?: DeliveryReason | null;
    readonly deliveredAt?: string | null;
    readonly destinationRelativePath: string | null;
  };
};

export type ContentPackageMode = "intent" | "full" | "custom";

/**
 * - complete:      every selected platform has a current canonical export
 * - incomplete:    at least one selected platform is missing or in flight
 * - stale:         nothing is missing/in flight, but at least one is stale
 * - blocked:       the track itself is not currently valid/renderable
 * - not_configured: no platform is selected at all
 */
export type ContentPackageStatus =
  | "complete"
  | "incomplete"
  | "stale"
  | "blocked"
  | "not_configured";

/**
 * - ready:        current canonical export exists for this platform
 * - missing:      required export does not exist and nothing is in flight
 * - stale:        an export exists but inputs changed since it was rendered
 * - rendering:    a render for this platform is queued or active right now
 * - blocked:      the track cannot be rendered at all
 * - not_selected: this platform is not part of the current package
 */
export type PlatformReadiness =
  | "ready"
  | "missing"
  | "stale"
  | "rendering"
  | "blocked"
  | "not_selected";

export type PlatformAction = "render" | "rerender" | "deliver";

export type ContentPackagePlatformEntry = {
  readonly platformId: PlatformId;
  readonly label: string;
  readonly presetId: RenderPresetId;
  readonly selected: boolean;
  readonly readiness: PlatformReadiness;
  /** The underlying export's raw status, for callers that want more detail. */
  readonly renderStatus: ExportFreshness | "queued" | "rendering" | null;
  readonly staleReasons: readonly StaleReason[];
  /** Descriptive alias, e.g. "ghetto-geek-youtube.mp4" — never a real path. */
  readonly outputFilename: string;
  readonly deliveryStatus: DeliveryStatus;
  /** Why deliveryStatus is not "delivered", when it isn't. Null once delivered, or when delivery is off. */
  readonly deliveryReason: DeliveryReason | null;
  /** When the currently-delivered copy went out, if it ever has. */
  readonly deliveredAt: string | null;
  readonly destinationRelativePath: string | null;
  /** YouTube only; null for caption-only platforms or a blocked track. */
  readonly title: string | null;
  /** YouTube only. */
  readonly description: string | null;
  /** YouTube only. */
  readonly keywords: readonly string[] | null;
  /** Reels/TikTok and Instagram only. */
  readonly caption: string | null;
  /** Reels/TikTok and Instagram only. */
  readonly hashtags: readonly string[] | null;
  readonly blockers: readonly string[];
  readonly actions: readonly PlatformAction[];
};

export type ContentPackageCounts = {
  readonly selected: number;
  readonly ready: number;
  readonly missing: number;
  readonly stale: number;
  readonly rendering: number;
  readonly blocked: number;
};

export type ContentPackageView = {
  readonly slug: string;
  readonly title: string | null;
  readonly mode: ContentPackageMode;
  readonly packageStatus: ContentPackageStatus;
  readonly platforms: readonly ContentPackagePlatformEntry[];
  readonly counts: ContentPackageCounts;
  readonly generatedAt: string;
  /**
   * Set when the global metadata-templates settings file could not be read
   * (missing is not a problem; malformed is). Carried through rather than
   * computed here, since reading that file is a caller/server concern — this
   * module stays pure. Built-in defaults are still used when this is set, so
   * generation never breaks; the point is that the drift is visible rather
   * than silently hidden (§ handoff, "Invalid template recovery").
   */
  readonly templatesProblem: string | null;
};

export type ContentPackageInput = {
  readonly slug: string;
  readonly title: string | null;
  /** validation.ok from the track's TrackDetailView/TrackSummaryView. */
  readonly validationOk: boolean;
  /**
   * Rendered-into metadata fields, or null when the track is not currently
   * valid/renderable. Platform metadata text is only ever built from this —
   * never from a draft — so a blocked track's preview is honestly empty
   * rather than describing fields that might not survive validation.
   */
  readonly metadata: PlatformMetadataSubject | null;
  /** One entry per render preset, in any order — from trackExportCoverage. */
  readonly exports: readonly PackageExportEntry[];
  /**
   * This track's own `contentMetadataOverrides`, or null/undefined when it
   * declares none. Resolved per field against `options.globalTemplates` and
   * the built-in defaults — never the sole source for any field.
   */
  readonly contentMetadataOverrides?: PartialMetadataTemplates | null;
};

export type ContentPackageOptions = {
  /**
   * "intent" (default) selects each platform whose underlying preset the
   * track's own exportPresets already intends — exactly what "intended" means
   * elsewhere in the app, so an existing track's package never silently grows
   * a format its metadata never declared. "full" selects every platform
   * regardless of intent, for a track that explicitly wants the whole social
   * set. `platforms` overrides both with an exact, caller-chosen set.
   */
  readonly mode?: "intent" | "full";
  readonly platforms?: readonly PlatformId[];
  /** Injectable clock, so tests can assert a byte-identical view. */
  readonly now?: () => string;
  /**
   * The global metadata-templates settings, or null/undefined when none are
   * configured. Sits between the track's own overrides and the built-in
   * defaults in precedence — see resolveMetadataTemplates().
   */
  readonly globalTemplates?: PartialMetadataTemplates | null;
  /** Passed straight through to the returned view; see ContentPackageView.templatesProblem. */
  readonly templatesProblem?: string | null;
};

const readinessFor = (
  selected: boolean,
  validationOk: boolean,
  status: ExportFreshness | "queued" | "rendering" | undefined,
): PlatformReadiness => {
  if (!selected) return "not_selected";
  if (!validationOk) return "blocked";
  switch (status) {
    case "current":
      return "ready";
    case "missing":
      return "missing";
    case "stale":
      return "stale";
    case "queued":
    case "rendering":
      return "rendering";
    case "invalid":
    default:
      return "blocked";
  }
};

const actionsFor = (
  readiness: PlatformReadiness,
  deliveryStatus: DeliveryStatus,
): readonly PlatformAction[] => {
  if (readiness === "missing") return ["render"];
  if (readiness === "stale") return ["rerender"];
  if (readiness === "ready") {
    return deliveryStatus === "delivered" ? [] : ["deliver"];
  }
  return [];
};

/** Derives a track's content package from state the app already computes. */
export const deriveContentPackage = (
  input: ContentPackageInput,
  options: ContentPackageOptions = {},
): ContentPackageView => {
  const now = options.now ?? (() => new Date().toISOString());

  const mode: ContentPackageMode =
    options.platforms !== undefined
      ? "custom"
      : options.mode === "full"
        ? "full"
        : "intent";

  const exportBySlug = new Map(
    input.exports.map((entry) => [entry.presetId, entry] as const),
  );

  const explicitSelection =
    options.platforms !== undefined
      ? new Set(canonicalPlatformOrder(options.platforms))
      : null;

  const templates = resolveMetadataTemplates(
    options.globalTemplates,
    input.contentMetadataOverrides,
  );

  const platforms: ContentPackagePlatformEntry[] = PLATFORM_LIST.map(
    (profile) => {
      const exportEntry = exportBySlug.get(profile.presetId);

      const selected =
        explicitSelection !== null
          ? explicitSelection.has(profile.id)
          : mode === "full"
            ? true
            : (exportEntry?.intended ?? false);

      const readiness = readinessFor(
        selected,
        input.validationOk,
        exportEntry?.status,
      );

      const metadata =
        input.metadata !== null
          ? buildPlatformMetadata(input.slug, profile.id, input.metadata, templates)
          : null;

      const blockers: string[] = [];
      if (selected && !input.validationOk) {
        blockers.push("Track is not currently valid — see validation notes.");
      }

      return {
        platformId: profile.id,
        label: profile.label,
        presetId: profile.presetId,
        selected,
        readiness,
        renderStatus: exportEntry?.status ?? null,
        staleReasons: exportEntry?.staleReasons ?? [],
        outputFilename: platformFilename(input.slug, profile.id),
        deliveryStatus: exportEntry?.delivery.status ?? "not_configured",
        deliveryReason: exportEntry?.delivery.reason ?? null,
        deliveredAt: exportEntry?.delivery.deliveredAt ?? null,
        destinationRelativePath:
          exportEntry?.delivery.destinationRelativePath ?? null,
        title: metadata?.title ?? null,
        description: metadata?.description ?? null,
        keywords: metadata?.keywords ?? null,
        caption: metadata?.caption ?? null,
        hashtags: metadata?.hashtags ?? null,
        blockers,
        actions: actionsFor(readiness, exportEntry?.delivery.status ?? "not_configured"),
      };
    },
  );

  const selectedPlatforms = platforms.filter((platform) => platform.selected);

  const counts: ContentPackageCounts = {
    selected: selectedPlatforms.length,
    ready: selectedPlatforms.filter((p) => p.readiness === "ready").length,
    missing: selectedPlatforms.filter((p) => p.readiness === "missing").length,
    stale: selectedPlatforms.filter((p) => p.readiness === "stale").length,
    rendering: selectedPlatforms.filter((p) => p.readiness === "rendering")
      .length,
    blocked: selectedPlatforms.filter((p) => p.readiness === "blocked").length,
  };

  const packageStatus: ContentPackageStatus =
    selectedPlatforms.length === 0
      ? "not_configured"
      : !input.validationOk || counts.blocked > 0
        ? "blocked"
        : counts.missing > 0 || counts.rendering > 0
          ? "incomplete"
          : counts.stale > 0
            ? "stale"
            : "complete";

  return {
    slug: input.slug,
    title: input.title,
    mode,
    packageStatus,
    platforms,
    counts,
    generatedAt: now(),
    templatesProblem: options.templatesProblem ?? null,
  };
};

/* ------------------------------------------------------------------ *
 * Copy, formatted for a human to paste elsewhere
 * ------------------------------------------------------------------ */

/**
 * One platform's resolved copy, exactly as `deriveContentPackage` already
 * produced it — never re-resolved, never approximated. Fields the platform
 * does not support (or a blocked/unresolved track leaves null) are left out
 * entirely rather than printed as an empty section.
 */
export const formatPlatformCopyForClipboard = (
  platform: ContentPackagePlatformEntry,
): string => {
  const sections: string[] = [];
  if (platform.title !== null) sections.push(`Title:\n${platform.title}`);
  if (platform.description !== null) sections.push(`Description:\n${platform.description}`);
  if (platform.keywords !== null && platform.keywords.length > 0) {
    sections.push(`Keywords:\n${platform.keywords.join(", ")}`);
  }
  if (platform.caption !== null) sections.push(`Caption:\n${platform.caption}`);
  if (platform.hashtags !== null && platform.hashtags.length > 0) {
    sections.push(`Hashtags:\n${platform.hashtags.join(" ")}`);
  }
  return sections.join("\n\n");
};

/**
 * Every selected platform's copy in one block, headed by platform name, for
 * pasting into notes or an upload workflow in one paste — the §9 "copy all
 * package metadata" action. A platform with nothing to show (not selected,
 * or blocked with no resolved metadata) is left out entirely rather than
 * printed as an empty heading.
 */
export const formatPackageCopyForClipboard = (
  platforms: readonly ContentPackagePlatformEntry[],
): string =>
  platforms
    .filter((platform) => platform.selected && (platform.title !== null || platform.caption !== null))
    .map((platform) => `${platform.label.toUpperCase()}\n\n${formatPlatformCopyForClipboard(platform)}`)
    .join("\n\n\n");
