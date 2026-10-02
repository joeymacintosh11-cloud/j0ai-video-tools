import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import type { TrackInspection } from "../../core/domain/tracks/types.ts";
import type { ReleaseBundleFreshness } from "../../core/domain/delivery/releaseBundle.ts";
import {
  generateReleaseBundle,
  releaseBundleStateFor,
  type GenerateReleaseBundleResult,
  type ReleaseBundleState,
} from "../delivery/releaseBundle.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "../delivery/deliverySettings.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { listTracks } from "../tracks/listTracks.ts";

/**
 * Plans and performs release bundle generation across tracks.
 *
 * Shares the delivery planner's conventions: tracks keep the order asked for,
 * omitting them means the whole catalogue, and a track that cannot be described
 * is reported rather than silently skipped.
 *
 * Only missing and outdated bundles are written by default. A current bundle is
 * left exactly as it is, so running this over a settled catalogue does no work
 * and rewrites nothing.
 */

export type ReleaseBundlePlan = {
  readonly catalogue: boolean;
  readonly tracks: number;
  readonly root: string | null;
  readonly rootProblem: string | null;
  /** Bundles that already describe what is at the destination. */
  readonly current: readonly ReleaseBundleState[];
  /** Bundles that exist but no longer match, and would be rewritten. */
  readonly outdated: readonly ReleaseBundleState[];
  /** Tracks with no bundle yet, which would get one. */
  readonly missing: readonly ReleaseBundleState[];
  /** Tracks nothing can be written for, with the reason. */
  readonly unavailable: readonly ReleaseBundleState[];
};

export type PlanReleaseBundlesInput = {
  readonly slugs?: readonly string[];
  readonly settings?: DeliverySettings;
};

const namedSlugs = (slugs: readonly string[]): readonly string[] => {
  if (slugs.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one track."),
    );
  }

  const seen = new Set<string>();
  const unique: string[] = [];

  for (const slug of slugs) {
    const valid = assertValidSlug(slug);
    if (!seen.has(valid)) {
      seen.add(valid);
      unique.push(valid);
    }
  }

  return unique;
};

export const planReleaseBundles = async (
  input: PlanReleaseBundlesInput,
): Promise<ReleaseBundlePlan> => {
  const catalogue = input.slugs === undefined;
  const settings = input.settings ?? (await readDeliverySettings());
  const { root, problem } = resolveDeliveryRoot(settings);

  const inspections: readonly TrackInspection[] = catalogue
    ? await listTracks()
    : await Promise.all(namedSlugs(input.slugs ?? []).map(inspectTrack));

  const current: ReleaseBundleState[] = [];
  const outdated: ReleaseBundleState[] = [];
  const missing: ReleaseBundleState[] = [];
  const unavailable: ReleaseBundleState[] = [];

  for (const inspection of inspections) {
    const state = releaseBundleStateFor(inspection, root);

    // A track with no destination, or one that cannot be described at all,
    // is set aside rather than counted as work.
    if (state.freshness === "not_configured" || state.problem !== null) {
      unavailable.push(state);
      continue;
    }

    const bucket: Record<ReleaseBundleFreshness, ReleaseBundleState[]> = {
      current,
      outdated,
      missing,
      not_configured: unavailable,
    };
    bucket[state.freshness].push(state);
  }

  return {
    catalogue,
    tracks: inspections.length,
    root,
    rootProblem: problem,
    current,
    outdated,
    missing,
    unavailable,
  };
};

/**
 * Writes every bundle the plan says needs one.
 *
 * Sequential, and each track is contained: a folder that cannot be written
 * reports its own failure and the rest of the catalogue still gets bundles.
 * `force` also rewrites bundles that are already current.
 */
export const generatePlannedBundles = async (
  plan: ReleaseBundlePlan,
  {
    settings,
    force = false,
  }: { readonly settings?: DeliverySettings; readonly force?: boolean } = {},
): Promise<readonly GenerateReleaseBundleResult[]> => {
  const resolved = settings ?? (await readDeliverySettings());
  const targets = force
    ? [...plan.missing, ...plan.outdated, ...plan.current]
    : [...plan.missing, ...plan.outdated];
  const results: GenerateReleaseBundleResult[] = [];

  for (const target of targets) {
    try {
      results.push(
        await generateReleaseBundle({
          slug: target.slug,
          settings: resolved,
          force,
        }),
      );
    } catch (error) {
      results.push({
        slug: target.slug,
        generated: false,
        freshness: target.freshness,
        relativePath: target.relativePath,
        bundleId: target.bundleId,
        delivered: target.delivered,
        outdated: target.outdated,
        missing: target.missing,
        problem: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return results;
};
