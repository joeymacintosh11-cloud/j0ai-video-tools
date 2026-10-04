import { exportStatusKey } from "../../core/domain/render/exportStatus.ts";
import type {
  TrackDetailView,
  TrackSummaryView,
} from "../../core/domain/api/views.ts";
import { publicLabel } from "../../core/domain/tracks/paths.ts";
import type { TrackInspection } from "../../core/domain/tracks/types.ts";
import {
  DEFAULT_RENDER_PRESET_ID,
  resolveExportPresets,
} from "../../core/domain/video/renderPresets.ts";
import {
  workflowRendererProblem,
  resolveTrackRenderer,
} from "../../core/domain/video/renderers.ts";
import { deliveryStateForTarget } from "../delivery/deliverExport.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
} from "../delivery/deliverySettings.ts";
import { releaseBundleStateFor } from "../delivery/releaseBundle.ts";
import { trackExportCoverage } from "../tracks/exportCoverage.ts";
import {
  trackLocations,
  trackOutputLocation,
} from "../tracks/trackLocations.ts";

/**
 * Turns a TrackInspection into the API's wire shape.
 *
 * The view types themselves live in core/domain/api/views.ts, shared with the
 * UI; this module is only the Node-side mapping, because it needs
 * trackLocations() for absolute paths. Shared by the API routes and the
 * content-package workflows (and so the CLI), which is why it lives here
 * rather than in server/.
 */

/**
 * The destination root for this response, or null when delivery is off.
 *
 * Resolved once per request: a listing then stats each export's destination at
 * most once, and with no destination configured it does no filesystem work at
 * all.
 */
export const deliveryRootForView = async (): Promise<string | null> =>
  resolveDeliveryRoot(await readDeliverySettings()).root;

export const toTrackSummaryView = (
  inspection: TrackInspection,
  /**
   * Work in flight, keyed by exportStatusKey(slug, presetId, renderer). Passed in rather than read from
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
  // Falls back to the draft for the same reason, so a not-yet-valid track that
  // prefers After Effects is judged against After Effects' exports too.
  const declaredRenderer =
    inspection.metadata?.renderer ?? inspection.metadataDraft?.renderer ?? null;
  const exportsRenderer = resolveTrackRenderer(declaredRenderer);
  // Delivery follows the preferred renderer; reserved engines remain unsupported.
  // Release bundles independently retain their Remotion-only restriction.
  const rendererProblem = workflowRendererProblem(exportsRenderer);
  // Computed once and shared with the release bundle status below, which needs
  // exactly the same facts; reading manifests twice per track would be waste.
  // Judged against the renderer this track prefers, so a Remotion export never
  // satisfies a track that asked for After Effects, or the other way round.
  const coverage = trackExportCoverage(
    inspection.slug,
    inspection.metadata,
    exportsRenderer,
  );
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
    exports: coverage.map(
      (facts) => {
        const state = inFlight.get(exportStatusKey(inspection.slug, facts.presetId, exportsRenderer));

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
          delivery:
            rendererProblem === null
              ? deliveryStateForTarget(
                  inspection.slug,
                  facts.presetId,
                  facts,
                  inspection.metadata === null ? null : deliveryRoot,
                  inspection.metadata?.deliveryFolder,
                  exportsRenderer,
                )
              : {
                  status: "not_configured",
                  reason: "renderer_not_supported",
                  destinationPath: null,
                  destinationRelativePath: null,
                  deliveredAt: null,
                },
        };
      },
    ),
    exportPresets: declared,
    renderer: declaredRenderer,
    exportsRenderer,
    deliveryFolder,
    releaseBundle: (() => {
      // Says itself when the track prefers a renderer bundles do not handle.
      const state = releaseBundleStateFor(
        inspection,
        inspection.metadata === null ? null : deliveryRoot,
        coverage,
      );

      return {
        freshness: state.freshness,
        relativePath: state.relativePath,
        generatedAt: state.generatedAt,
        delivered: state.delivered,
        outdated: state.outdated,
        missing: state.missing,
        problem: state.problem,
      };
    })(),
  };
};

export const toTrackDetailView = (
  inspection: TrackInspection,
  /**
   * Work in flight, keyed by exportStatusKey(slug, presetId, renderer). Passed in rather than read from
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
