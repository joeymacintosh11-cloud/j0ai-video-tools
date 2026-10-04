import { exportStatusKey } from "../../core/domain/render/exportStatus.ts";
import {
  assertExportMode,
  type ExportMode,
  type StaleReason,
} from "../../core/domain/video/exportFreshness.ts";
import type { RenderTarget } from "../../core/domain/api/views.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import type { TrackInspection } from "../../core/domain/tracks/types.ts";
import {
  assertRenderPresetId,
  canonicalPresetOrder,
  RENDER_PRESETS,
  resolveExportPresets,
  type RenderPresetId,
} from "../../core/domain/video/renderPresets.ts";
import {
  workflowRendererProblem,
  workflowEngineField,
  rendererRunProblem,
  type RendererId,
  type RendererStatus,
  resolveTrackRenderer,
} from "../../core/domain/video/renderers.ts";
import { trackExportCoverage } from "../tracks/exportCoverage.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { listTracks } from "../tracks/listTracks.ts";

/**
 * Plans missing and/or stale exports, defaulting to missing-only compatibility.
 *
 * Which formats a track *should* have comes from its own metadata, so a
 * catalogue-wide run plans each track's declared intent rather than flattening
 * everything into one global format list. A caller that names formats
 * explicitly overrides that intent for the request — which is what the toolbar
 * and the CLI's --preset do — and a track that declares nothing resolves to
 * every format, exactly as before intent existed.
 *
 * Three different things can mean "no work needed", and they are reported
 * separately rather than lumped together, because they need different answers
 * from a user: the file is already there, a render is already queued, or one is
 * running right now. A track that cannot be rendered at all is reported with
 * the reason rather than silently dropped.
 *
 * The filesystem and sidecar manifests decide freshness — never job history, which is
 * in memory and forgotten on restart. A finished export whose job record has
 * been trimmed is still an export.
 */

export type PlannedTarget = {
  readonly engine?: RendererId;
  readonly staleReasons?: readonly StaleReason[];
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
  readonly mode: ExportMode;
  readonly stale: readonly PlannedTarget[];
  readonly current: readonly PlannedTarget[];
  readonly selected: readonly PlannedTarget[];
  /** True when the plan covered the whole catalogue rather than named tracks. */
  readonly catalogue: boolean;
  /** How many tracks were considered, renderable or not. */
  readonly tracks: number;
  /** Every track/format pair the tracks are meant to ship, missing or not. */
  readonly intendedTargets: readonly PlannedTarget[];
  readonly missing: readonly PlannedTarget[];
  readonly skippedExisting: readonly PlannedTarget[];
  readonly skippedQueued: readonly PlannedTarget[];
  readonly skippedActive: readonly PlannedTarget[];
  readonly invalid: readonly InvalidTrack[];
};

export type PlanMissingExportsInput = {
  readonly mode?: ExportMode;
  /**
   * Tracks to cover. Omitted means every track under public/tracks/ — the
   * catalogue-wide run. An explicitly empty list is a mistake, not a catalogue.
   */
  readonly slugs?: readonly string[];
  /**
   * Formats to cover, overriding metadata for this request. Omitted means each
   * track's own declared intent.
   */
  readonly presetIds?: readonly RenderPresetId[] | null;
  /**
   * Work already in flight, keyed by exportStatusKey(slug, presetId, renderer). Passed in rather than
   * read from the render manager here, so this module stays free of the
   * server's queue: the API route supplies the live map, and the CLI — a
   * separate process that knows nothing of a running server — supplies nothing.
   */
  readonly renderers?: readonly RendererStatus[];
  readonly inFlight?: ReadonlyMap<string, "queued" | "active">;
};

/** Validates and de-duplicates named tracks, keeping the order asked for. */
const namedSlugs = (slugs: readonly string[]): readonly string[] => {
  if (slugs.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one track to export."),
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

/**
 * The formats named by the caller, or null to mean "use each track's intent".
 *
 * Always returned in canonical preset order, so the queue is deterministic
 * regardless of how the request was written.
 */
const requestedPresets = (
  presetIds: readonly RenderPresetId[] | null | undefined,
): readonly RenderPresetId[] | null => {
  if (presetIds === undefined || presetIds === null) {
    return null;
  }

  if (presetIds.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one export format."),
    );
  }

  return canonicalPresetOrder(presetIds.map((id) => assertRenderPresetId(id)));
};

export const planMissingExports = async (
  input: PlanMissingExportsInput,
): Promise<ExportPlan> => {
  const mode = assertExportMode(input.mode);
  const catalogue = input.slugs === undefined;
  const override = requestedPresets(input.presetIds);
  const inFlight = input.inFlight ?? new Map<string, "queued" | "active">();

  // Catalogue mode inspects every track in one pass, in slug order. Named
  // tracks are inspected individually, in the order they were asked for.
  const inspections: readonly TrackInspection[] = catalogue
    ? await listTracks()
    : await Promise.all(namedSlugs(input.slugs ?? []).map(inspectTrack));

  const intendedTargets: PlannedTarget[] = [];
  const missing: PlannedTarget[] = [];
  const stale: PlannedTarget[] = [];
  const current: PlannedTarget[] = [];
  const selected: PlannedTarget[] = [];
  const skippedExisting: PlannedTarget[] = [];
  const skippedQueued: PlannedTarget[] = [];
  const skippedActive: PlannedTarget[] = [];
  const invalid: InvalidTrack[] = [];

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

    const renderer = resolveTrackRenderer(inspection.metadata?.renderer);
    const rendererProblem = workflowRendererProblem(renderer);
    if (rendererProblem !== null) {
      invalid.push({ slug, code: "RENDERER_NOT_SUPPORTED", reason: rendererProblem });
      continue;
    }

    const presetIds =
      override ?? resolveExportPresets(inspection.metadata?.exportPresets);
    const coverage = trackExportCoverage(slug, inspection.metadata, renderer);

    for (const presetId of presetIds) {
      const facts = coverage.find((entry) => entry.presetId === presetId);
      const target: PlannedTarget = {
        ...workflowEngineField(renderer),
        slug,
        presetId,
        label: RENDER_PRESETS[presetId].shortLabel,
        outputLabel: facts?.outputLabel ?? "",
        ...(facts?.staleReasons.length
          ? { staleReasons: facts.staleReasons }
          : {}),
      };

      intendedTargets.push(target);

      const state = inFlight.get(exportStatusKey(slug, presetId, renderer));
      if (state === "active") {
        skippedActive.push(target);
        continue;
      }
      if (state === "queued") {
        skippedQueued.push(target);
        continue;
      }

      if (facts?.freshness === "invalid") {
        if (!invalid.some((entry) => entry.slug === slug))
          invalid.push({
            slug,
            code: "INVALID_REQUEST",
            reason: "Cannot read export inputs; check the track files.",
          });
      } else if (facts?.rendered) {
        skippedExisting.push(target); // Backwards-compatible presence list.
        if (facts.freshness === "current") current.push(target);
        else {
          stale.push(target);
          if (mode !== "missing") selected.push(target);
        }
      } else {
        missing.push(target);
        if (mode !== "stale") selected.push(target);
      }
    }
  }

  const runnable = selected.filter((target) => {
    const reason = rendererRunProblem(resolveTrackRenderer(target.engine), input.renderers);
    if (reason === null) return true;
    if (!invalid.some((entry) => entry.slug === target.slug)) {
      invalid.push({ slug: target.slug, code: "RENDERER_UNAVAILABLE", reason });
    }
    return false;
  });
  return {
    mode,
    stale,
    current,
    selected: runnable,
    catalogue,
    tracks: inspections.length,
    intendedTargets,
    missing,
    skippedExisting,
    skippedQueued,
    skippedActive,
    invalid,
  };
};

/** The mode-selected targets, in the shape startBatch takes. */
export const toRenderTargets = (plan: ExportPlan): readonly RenderTarget[] =>
  plan.selected.map((target) => ({
    slug: target.slug,
    preset: target.presetId,
    ...workflowEngineField(resolveTrackRenderer(target.engine)),
  }));
