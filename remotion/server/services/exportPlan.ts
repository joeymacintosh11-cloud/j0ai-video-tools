import type { RenderTarget } from "../../src/domain/api/views.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import {
  assertRenderPresetId,
  RENDER_PRESET_LIST,
  RENDER_PRESETS,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import { trackExportCoverage } from "../../services/tracks/exportCoverage.ts";
import { inspectTrack } from "../../services/tracks/inspectTrack.ts";
import { renderManager } from "./renderManager.ts";

/**
 * Works out which exports a set of tracks is actually missing.
 *
 * Three different things can mean "no work needed", and they are reported
 * separately rather than lumped together, because they need different answers
 * from a user: the file is already there, a render is already queued, or one is
 * running right now. A track that cannot be rendered at all is reported with
 * the reason rather than silently dropped.
 *
 * The filesystem decides what already exists — never the job history, which is
 * in memory and forgotten on restart. A finished export whose job record has
 * been trimmed is still an export.
 */

export type PlannedTarget = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  /** Short preset label, e.g. "Reels 9:16". */
  readonly label: string;
  readonly outputLabel: string;
};

export type InvalidTrack = {
  readonly slug: string;
  readonly code: string;
  readonly reason: string;
};

export type ExportPlan = {
  readonly missing: readonly PlannedTarget[];
  readonly skippedExisting: readonly PlannedTarget[];
  readonly skippedQueued: readonly PlannedTarget[];
  readonly skippedActive: readonly PlannedTarget[];
  readonly invalid: readonly InvalidTrack[];
};

export type PlanMissingExportsInput = {
  readonly slugs: readonly string[];
  readonly presetIds: readonly RenderPresetId[];
};

/**
 * Normalises the request: validates every slug and preset, drops duplicates,
 * and fixes the order.
 *
 * Tracks keep the order asked for, formats always take canonical preset order.
 * That makes the queue deterministic regardless of how the request was written,
 * so the same request twice produces the same plan.
 */
const normalise = ({
  slugs,
  presetIds,
}: PlanMissingExportsInput): {
  readonly slugs: readonly string[];
  readonly presets: readonly { id: RenderPresetId; label: string }[];
} => {
  if (slugs.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one track to export."),
    );
  }

  if (presetIds.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one export format."),
    );
  }

  const validated = presetIds.map((id) => assertRenderPresetId(id));
  const wanted = new Set<RenderPresetId>(validated);

  const seen = new Set<string>();
  const uniqueSlugs: string[] = [];
  for (const slug of slugs) {
    const valid = assertValidSlug(slug);
    if (!seen.has(valid)) {
      seen.add(valid);
      uniqueSlugs.push(valid);
    }
  }

  return {
    slugs: uniqueSlugs,
    presets: RENDER_PRESET_LIST.filter((preset) => wanted.has(preset.id)).map(
      (preset) => ({ id: preset.id, label: preset.shortLabel }),
    ),
  };
};

export const planMissingExports = async (
  input: PlanMissingExportsInput,
): Promise<ExportPlan> => {
  const { slugs, presets } = normalise(input);
  const inFlight = renderManager.inFlightTargets();

  const missing: PlannedTarget[] = [];
  const skippedExisting: PlannedTarget[] = [];
  const skippedQueued: PlannedTarget[] = [];
  const skippedActive: PlannedTarget[] = [];
  const invalid: InvalidTrack[] = [];

  for (const slug of slugs) {
    const inspection = await inspectTrack(slug);

    if (!inspection.facts.trackDirExists) {
      invalid.push({
        slug,
        code: "TRACK_NOT_FOUND",
        reason: `Track "${slug}" not found.`,
      });
      continue;
    }

    // A track that cannot be rendered is reported once, with the reason, rather
    // than producing one failing job per format.
    if (!inspection.validation.ok) {
      const first = inspection.validation.errors[0];
      invalid.push({
        slug,
        code: first?.code ?? "METADATA_INVALID",
        reason: first?.message ?? `Track "${slug}" is not renderable.`,
      });
      continue;
    }

    const coverage = trackExportCoverage(slug);

    for (const preset of presets) {
      const facts = coverage.find((entry) => entry.presetId === preset.id);
      const target: PlannedTarget = {
        slug,
        presetId: preset.id,
        label: preset.label,
        outputLabel: facts?.outputLabel ?? "",
      };

      // Disk first: a finished file is never re-rendered automatically.
      if (facts?.rendered) {
        skippedExisting.push(target);
        continue;
      }

      const state = inFlight.get(`${slug}::${preset.id}`);
      if (state === "active") {
        skippedActive.push(target);
        continue;
      }
      if (state === "queued") {
        skippedQueued.push(target);
        continue;
      }

      missing.push(target);
    }
  }

  return { missing, skippedExisting, skippedQueued, skippedActive, invalid };
};

/** The plan's missing targets, in the shape startBatch takes. */
export const toRenderTargets = (
  plan: ExportPlan,
): readonly RenderTarget[] =>
  plan.missing.map((target) => ({
    slug: target.slug,
    preset: target.presetId,
  }));

/** Every format, for a caller that did not narrow the request. */
export const allPresetIds = (): readonly RenderPresetId[] =>
  RENDER_PRESET_LIST.map((preset) => RENDER_PRESETS[preset.id].id);
