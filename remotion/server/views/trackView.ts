import type {
  TrackDetailView,
  TrackSummaryView,
} from "../../src/domain/api/views.ts";
import { publicLabel } from "../../src/domain/tracks/paths.ts";
import type { TrackInspection } from "../../src/domain/tracks/types.ts";
import {
  DEFAULT_RENDER_PRESET_ID,
  RENDER_PRESET_LIST,
} from "../../src/domain/video/renderPresets.ts";
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
  const defaultOutput = trackOutputLocation(
    inspection.slug,
    DEFAULT_RENDER_PRESET_ID,
  );
  const defaultPresent = inspection.facts.renderedPresets.includes(
    DEFAULT_RENDER_PRESET_ID,
  );

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
      // Per-format outputs. The UI reads this; the three fields below stay for
      // callers written before presets existed.
      outputs: RENDER_PRESET_LIST.map((preset) => {
        const output = trackOutputLocation(inspection.slug, preset.id);
        const present = inspection.facts.renderedPresets.includes(preset.id);

        return {
          presetId: preset.id,
          label: preset.shortLabel,
          outputLabel: output.label,
          outputPath: present ? output.path : null,
          present,
        };
      }),
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
