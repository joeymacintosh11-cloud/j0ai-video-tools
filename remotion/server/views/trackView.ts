import type {
  TrackDetailView,
  TrackSummaryView,
} from "../../src/domain/api/views.ts";
import { publicLabel } from "../../src/domain/tracks/paths.ts";
import type { TrackInspection } from "../../src/domain/tracks/types.ts";
import {
  DEFAULT_RENDER_PRESET_ID,
  resolveExportPresets,
} from "../../src/domain/video/renderPresets.ts";
import { deliveryStateForTarget } from "../../services/delivery/deliverExport.ts";
import { trackExportCoverage } from "../../services/tracks/exportCoverage.ts";
import {
  trackLocations,
  trackOutputLocation,
} from "../../services/tracks/trackLocations.ts";

/**
 * Turns a TrackInspection into the API's wire shape.
 *
 * The view types themselves live in src/domain/api/views.ts, shared with the
 * UI; this module is only the Node-side mapping, because it needs
 * trackLocations() for absolute paths.
 */

export const toTrackSummaryView = (
  inspection: TrackInspection,
  /**
   * Work in flight, keyed "<slug>::<presetId>". Passed in rather than read from
   * the render manager here, so this stays a pure mapping and the queue stays
   * the caller's concern. Omitted means "nothing in flight".
   */
  inFlight: ReadonlyMap<string, "queued" | "active"> = new Map(),
  /**
   * The configured destination root, or null when delivery is off. Passed in
   * rather than read here, so a listing resolves settings once instead of once
   * per track, and this stays a pure mapping. With delivery off, no destination
   * is stat'd at all.
   */
  deliveryRoot: string | null = null,
): TrackSummaryView => {
  // Falls back to the draft so a track that is not yet renderable still reports
  // the intent it was created with, exactly as its title does.
  const declared =
    inspection.metadata?.exportPresets ??
    inspection.metadataDraft?.exportPresets ??
    null;
  const intended = new Set(resolveExportPresets(declared));
  const deliveryFolder =
    inspection.metadata?.deliveryFolder ??
    inspection.metadataDraft?.deliveryFolder ??
    null;

  return {
    slug: inspection.slug,
    // Falls back to the draft's title so a track that is not yet valid still
    // shows the name it was created with, rather than its slug. An empty title
    // stays null so callers can apply their own fallback.
    title:
      inspection.metadata?.title ?? (inspection.metadataDraft?.title || null),
    status: inspection.status,
    metadataPresent: inspection.facts.metadataExists,
    metadataValid: inspection.metadata !== null,
    coverPresent: inspection.facts.coverExists,
    audioPresent: inspection.facts.beatExists,
    analysisPresent: inspection.facts.analysisExists,
    analysisUpToDate: inspection.facts.analysisUpToDate,
    renderPresent: inspection.facts.outputExists,
    exports: trackExportCoverage(inspection.slug, inspection.metadata).map(
      (facts) => {
        const state = inFlight.get(`${inspection.slug}::${facts.presetId}`);

        return {
          freshness: facts.freshness,
          staleReasons: facts.staleReasons,
          status:
            state === "active"
              ? "rendering"
              : state === "queued"
                ? "queued"
                : !inspection.validation.ok
                  ? "invalid"
                  : facts.freshness,
          presetId: facts.presetId,
          label: facts.label,
          outputLabel: facts.outputLabel,
          outputPath: facts.rendered ? facts.outputPath : null,
          present: facts.rendered,
          bytes: facts.bytes,
          modifiedAt: facts.modifiedAt,
          empty: facts.empty,
          queued: state === "queued",
          active: state === "active",
          intended: intended.has(facts.presetId),
          delivery: deliveryStateForTarget(
            inspection.slug,
            facts.presetId,
            facts,
            inspection.metadata === null ? null : deliveryRoot,
            inspection.metadata?.deliveryFolder,
          ),
        };
      },
    ),
    exportPresets: declared,
    deliveryFolder,
  };
};

export const toTrackDetailView = (
  inspection: TrackInspection,
  /**
   * Work in flight, keyed "<slug>::<presetId>". Passed in rather than read from
   * the render manager here, so this stays a pure mapping and the queue stays
   * the caller's concern. Omitted means "nothing in flight".
   */
  inFlight: ReadonlyMap<string, "queued" | "active"> = new Map(),
  /** The configured destination root, or null when delivery is off. */
  deliveryRoot: string | null = null,
): TrackDetailView => {
  const locations = trackLocations(inspection.slug);
  const defaultOutput = trackOutputLocation(
    inspection.slug,
    DEFAULT_RENDER_PRESET_ID,
  );
  const defaultPresent = inspection.facts.renderedPresets.includes(
    DEFAULT_RENDER_PRESET_ID,
  );
  return {
    ...toTrackSummaryView(inspection, inFlight, deliveryRoot),
    metadata: inspection.metadata,
    metadataDraft: inspection.metadataDraft,
    metadataRevision: inspection.metadataRevision,
    validation: inspection.validation,
    assets: {
      cover: publicLabel(inspection.paths.cover),
      beat: publicLabel(inspection.paths.beat),
      analysis: publicLabel(inspection.paths.analysis),
      metadata: publicLabel(inspection.paths.metadata),
    },
    render: {
      present: inspection.facts.outputExists,
      legacyPresent: inspection.facts.legacyOutputExists,
      /** The default format's output, or the pre-preset file if that is what exists. */
      outputLabel: defaultOutput.label,
      outputPath: defaultPresent
        ? defaultOutput.path
        : inspection.facts.legacyOutputExists
          ? locations.legacyOutput
          : null,
    },
    previewEndpoint: `/api/tracks/${inspection.slug}/preview`,
  };
};

export type { TrackDetailView, TrackSummaryView };
