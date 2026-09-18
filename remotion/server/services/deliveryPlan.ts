import {
  deliveryFolderFor,
  type DeliveryReason,
  type DeliveryStatus,
} from "../../src/domain/delivery/deliveryPaths.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import type { ExportFreshness } from "../../src/domain/video/exportFreshness.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import type { TrackInspection } from "../../src/domain/tracks/types.ts";
import {
  assertRenderPresetId,
  canonicalPresetOrder,
  RENDER_PRESETS,
  resolveExportPresets,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import {
  deliverExport,
  deliveryStateForTarget,
  type DeliveryOutcome,
} from "../../services/delivery/deliverExport.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "../../services/delivery/deliverySettings.ts";
import { trackExportCoverage } from "../../services/tracks/exportCoverage.ts";
import { inspectTrack } from "../../services/tracks/inspectTrack.ts";
import { listTracks } from "../../services/tracks/listTracks.ts";

/**
 * Works out which current exports are not yet at the destination.
 *
 * Shares the export planner's shape and conventions on purpose: tracks keep the
 * order asked for, formats take canonical preset order, omitting the tracks
 * means the whole catalogue, and each track's own intended formats decide what
 * counts unless the caller names formats explicitly.
 *
 * Only *current* exports are deliverable. Stale and missing ones are reported
 * in their own lists so the answer is "re-render these first", not a silent
 * omission.
 */

export type DeliveryTarget = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  /** Short preset label, e.g. "Reels 9:16". */
  readonly label: string;
  readonly outputLabel: string;
  /**
   * The canonical export's freshness. Carried alongside the delivery status
   * because the two answer different questions, and a target that cannot be
   * delivered needs to say what is wrong with the *export*, not with the copy.
   */
  readonly freshness: ExportFreshness;
  readonly status: DeliveryStatus;
  readonly reason: DeliveryReason | null;
  readonly destinationRelativePath: string | null;
};

export type InvalidDeliveryTrack = {
  readonly slug: string;
  readonly code: string;
  readonly reason: string;
};

export type DeliveryPlan = {
  readonly catalogue: boolean;
  readonly tracks: number;
  /** Absolute destination root, or null when delivery is off. */
  readonly root: string | null;
  /** Why the configured root is unusable right now, if it is. */
  readonly rootProblem: string | null;
  /** Every intended export considered, whatever its state. */
  readonly considered: readonly DeliveryTarget[];
  /** Current exports whose destination copy is missing or out of date. */
  readonly deliverable: readonly DeliveryTarget[];
  /** Already at the destination and matching the current export. */
  readonly alreadyDelivered: readonly DeliveryTarget[];
  /** Cannot be delivered until re-rendered. */
  readonly notCurrent: readonly DeliveryTarget[];
  readonly invalid: readonly InvalidDeliveryTrack[];
};

export type PlanDeliveriesInput = {
  readonly slugs?: readonly string[];
  readonly presetIds?: readonly RenderPresetId[] | null;
  readonly settings?: DeliverySettings;
};

const namedSlugs = (slugs: readonly string[]): readonly string[] => {
  if (slugs.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one track to deliver."),
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

const requestedPresets = (
  presetIds: readonly RenderPresetId[] | null | undefined,
): readonly RenderPresetId[] | null => {
  if (presetIds === undefined || presetIds === null) return null;

  if (presetIds.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one export format."),
    );
  }

  return canonicalPresetOrder(presetIds.map((id) => assertRenderPresetId(id)));
};

export const planDeliveries = async (
  input: PlanDeliveriesInput,
): Promise<DeliveryPlan> => {
  const catalogue = input.slugs === undefined;
  const override = requestedPresets(input.presetIds);
  const settings = input.settings ?? (await readDeliverySettings());
  const { root, problem } = resolveDeliveryRoot(settings);

  const inspections: readonly TrackInspection[] = catalogue
    ? await listTracks()
    : await Promise.all(namedSlugs(input.slugs ?? []).map(inspectTrack));

  const considered: DeliveryTarget[] = [];
  const deliverable: DeliveryTarget[] = [];
  const alreadyDelivered: DeliveryTarget[] = [];
  const notCurrent: DeliveryTarget[] = [];
  const invalid: InvalidDeliveryTrack[] = [];

  for (const inspection of inspections) {
    const { slug } = inspection;

    if (!inspection.facts.trackDirExists) {
      invalid.push({
        slug,
        code: "TRACK_NOT_FOUND",
        reason: `Track "${slug}" not found.`,
      });
      continue;
    }

    if (!inspection.validation.ok) {
      const first = inspection.validation.errors[0];
      invalid.push({
        slug,
        code: first?.code ?? "METADATA_INVALID",
        reason: first?.message ?? `Track "${slug}" is not renderable.`,
      });
      continue;
    }

    const presetIds =
      override ?? resolveExportPresets(inspection.metadata?.exportPresets);
    const coverage = trackExportCoverage(slug, inspection.metadata);
    const folder = inspection.metadata?.deliveryFolder ?? null;

    for (const presetId of presetIds) {
      const facts = coverage.find((entry) => entry.presetId === presetId);
      if (facts === undefined) continue;

      const state = deliveryStateForTarget(slug, presetId, facts, root, folder);
      const notCurrentYet = facts.freshness !== "current";
      const target: DeliveryTarget = {
        slug,
        presetId,
        label: RENDER_PRESETS[presetId].shortLabel,
        outputLabel: facts.outputLabel,
        freshness: facts.freshness,
        status: state.status,
        // For something that cannot be delivered at all, the useful reason is
        // the export's state rather than the copy's: "never delivered" would
        // be true but would point at the wrong fix.
        reason: notCurrentYet
          ? facts.rendered
            ? "export_not_current"
            : "export_missing"
          : state.reason,
        destinationRelativePath: state.destinationRelativePath,
      };

      considered.push(target);

      if (notCurrentYet) notCurrent.push(target);
      else if (state.status === "delivered") alreadyDelivered.push(target);
      else if (root !== null) deliverable.push(target);
    }
  }

  return {
    catalogue,
    tracks: inspections.length,
    root,
    rootProblem: problem,
    considered,
    deliverable,
    alreadyDelivered,
    notCurrent,
    invalid,
  };
};

/**
 * Copies every deliverable target, one after another.
 *
 * Sequential on purpose: these are large files on one disk, and copying several
 * at once would only contend for the same bandwidth. Each target's outcome is
 * reported, so one failure never stops the rest.
 */
export const deliverPlanned = async (
  plan: DeliveryPlan,
  settings?: DeliverySettings,
): Promise<readonly DeliveryOutcome[]> => {
  const resolved = settings ?? (await readDeliverySettings());
  const outcomes: DeliveryOutcome[] = [];

  for (const target of plan.deliverable) {
    outcomes.push(
      await deliverExport({
        slug: target.slug,
        presetId: target.presetId,
        settings: resolved,
      }),
    );
  }

  return outcomes;
};

/** Where a track delivers to, for display. */
export const trackDeliveryFolder = (
  slug: string,
  declared: string | null | undefined,
): string => deliveryFolderFor(slug, declared);
