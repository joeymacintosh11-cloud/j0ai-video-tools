import type {
  TrackDetailView,
  TrackSummaryView,
} from "../../src/domain/api/views.ts";
import { publicLabel } from "../../src/domain/tracks/paths.ts";
import type { TrackInspection } from "../../src/domain/tracks/types.ts";
import { trackLocations } from "../../services/tracks/trackLocations.ts";

/**
 * Turns a TrackInspection into the API's wire shape.
 *
 * The view types themselves live in src/domain/api/views.ts, shared with the
 * UI; this module is only the Node-side mapping, because it needs
 * trackLocations() for absolute paths.
 */

export const toTrackSummaryView = (
  inspection: TrackInspection,
): TrackSummaryView => ({
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
});

export const toTrackDetailView = (
  inspection: TrackInspection,
): TrackDetailView => {
  const locations = trackLocations(inspection.slug);

  return {
    ...toTrackSummaryView(inspection),
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
      outputLabel: `out/${inspection.slug}.mp4`,
      outputPath: inspection.facts.outputExists ? locations.output : null,
    },
    previewEndpoint: `/api/tracks/${inspection.slug}/preview`,
  };
};

export type { TrackDetailView, TrackSummaryView };
