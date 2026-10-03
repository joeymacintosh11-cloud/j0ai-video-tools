import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import type { TrackInspection } from "../../core/domain/tracks/types.ts";
import {
  deriveContentPackage,
  type ContentPackageInput,
  type ContentPackageMode,
} from "../../core/domain/content/contentPackage.ts";
import type { ContentPackageBatchTrack } from "../../core/domain/content/contentPackageBatch.ts";
import { assertPlatformId, type PlatformId } from "../../core/domain/content/platformProfiles.ts";
import type { PartialMetadataTemplates } from "../../core/domain/content/metadataTemplates.ts";
import { readContentMetadataSettings } from "../content/metadataTemplateSettings.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { deliveryRootForView, toTrackDetailView } from "./trackView.ts";
import { renderManager } from "./renderManager.ts";

/**
 * The I/O half of Content Package batch planning. The pure half — turning
 * per-track packages into an aggregated view or an action plan — lives in
 * core/domain/content/contentPackageBatch.ts and is re-exported below so
 * routes and the CLI need one import.
 */
export {
  planContentPackageBatch,
  toRenderTargetsFromPlan,
  type ContentPackageActionKind,
  type ContentPackageBatchPlan,
  type ContentPackagePlannedAction,
} from "../../core/domain/content/contentPackageBatch.ts";

export const MAX_BATCH_TRACKS = 100;

/**
 * Validates, de-duplicates (keeping the first occurrence and reporting the
 * rest) and bounds a batch's requested tracks. An empty list is a mistake,
 * not "the whole catalogue" — a batch never silently covers tracks the
 * caller did not name (mirrors exportPlan.ts's `namedSlugs`, minus catalogue
 * mode, which Content Package batches do not offer at the API layer; the CLI
 * resolves --catalogue to an explicit track list itself before calling in).
 */
export const namedBatchSlugs = (
  slugs: readonly string[],
): { readonly slugs: readonly string[]; readonly duplicates: readonly string[] } => {
  if (slugs.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one track for a batch."),
    );
  }
  if (slugs.length > MAX_BATCH_TRACKS) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        `A batch may contain at most ${MAX_BATCH_TRACKS} tracks; received ${slugs.length}.`,
      ),
    );
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  const duplicates: string[] = [];

  for (const slug of slugs) {
    const valid = assertValidSlug(slug);
    if (seen.has(valid)) {
      duplicates.push(valid);
      continue;
    }
    seen.add(valid);
    unique.push(valid);
  }

  return { slugs: unique, duplicates };
};

export type ContentPackageBatchContext = {
  readonly inFlight: ReadonlyMap<string, "queued" | "active">;
  readonly deliveryRoot: string | null;
  readonly globalTemplates: PartialMetadataTemplates | null;
  readonly templatesProblem: string | null;
};

/**
 * Reads everything a batch's tracks share exactly once: the destination
 * root, the global metadata templates, and the render queue's current state.
 * Passed into every per-track derivation below instead of re-read per track —
 * the performance requirement this module exists to satisfy (no full
 * catalogue scan, and no repeated settings/queue reads, per selected track).
 *
 * In-flight state is read fresh again by the apply route right before
 * queueing (see server/routes/contentPackageBatch.ts), so a stale read here
 * only affects the *displayed* plan, never what actually gets queued.
 */
export const loadContentPackageBatchContext =
  async (): Promise<ContentPackageBatchContext> => {
    const [deliveryRoot, templateSettings] = await Promise.all([
      deliveryRootForView(),
      readContentMetadataSettings(),
    ]);

    return {
      inFlight: renderManager.inFlightTargets(),
      deliveryRoot,
      globalTemplates: templateSettings.settings.templates,
      templatesProblem: templateSettings.problem,
    };
  };

export type ContentPackageBatchOptions = {
  readonly mode?: Exclude<ContentPackageMode, "custom">;
  readonly platforms?: readonly PlatformId[];
};

/**
 * Builds each track's content package the same way the single-track route
 * does — `inspectTrack` → `toTrackDetailView` → `deriveContentPackage`, the
 * exact resolver GET /api/content-package uses — just sharing the context
 * every track needs instead of gathering it per track.
 */
export const buildContentPackagesForSlugs = async (
  slugs: readonly string[],
  context: ContentPackageBatchContext,
  options: ContentPackageBatchOptions = {},
): Promise<readonly ContentPackageBatchTrack[]> => {
  const inspections: readonly TrackInspection[] = await Promise.all(
    slugs.map((slug) => inspectTrack(slug)),
  );

  return inspections.map((inspection) => {
    if (!inspection.facts.trackDirExists) {
      return {
        slug: inspection.slug,
        found: false as const,
        reason: `Track "${inspection.slug}" not found.`,
      };
    }

    const detail = toTrackDetailView(
      inspection,
      context.inFlight,
      context.deliveryRoot,
    );

    const input: ContentPackageInput = {
      slug: detail.slug,
      title: detail.title,
      validationOk: detail.validation.ok,
      metadata: detail.metadata,
      exports: detail.exports,
      renderer: detail.exportsRenderer,
      contentMetadataOverrides: detail.metadata?.contentMetadataOverrides,
    };

    const pkg = deriveContentPackage(input, {
      mode: options.mode,
      platforms: options.platforms,
      globalTemplates: context.globalTemplates,
      templatesProblem: context.templatesProblem,
    });

    return { slug: inspection.slug, found: true as const, package: pkg };
  });
};

/* ------------------------------------------------------------------ *
 * Request-body shape checks, shared by inspect/plan/apply
 * ------------------------------------------------------------------ */

export const readBatchPlatforms = (
  value: unknown,
): readonly PlatformId[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        '"platforms" must be a non-empty array when provided, or left out to use mode.',
      ),
    );
  }
  return value.map((entry) => assertPlatformId(entry));
};

export const readBatchMode = (
  value: unknown,
): Exclude<ContentPackageMode, "custom"> => {
  if (value === undefined || value === null) return "intent";
  if (value !== "intent" && value !== "full") {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", 'mode must be "intent" or "full".'),
    );
  }
  return value;
};

export const readBatchTracks = (value: unknown): readonly string[] => {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        'Provide a non-empty "tracks" array, e.g. {"tracks":["ghetto-geek"]}.',
      ),
    );
  }
  return value.map((slug, index) => {
    if (typeof slug !== "string" || slug.length === 0) {
      throw new TrackError(
        trackIssue("INVALID_REQUEST", `tracks[${index}] must be a string.`),
      );
    }
    return slug;
  });
};
