import { publicLabel } from "../../src/domain/tracks/paths.ts";
import type {
  TrackInspection,
  TrackStatus,
  ValidationResult,
} from "../../src/domain/tracks/types.ts";
import { trackLocations } from "../../services/tracks/trackLocations.ts";

export type TrackSummaryView = {
  readonly slug: string;
  readonly title: string | null;
  readonly status: TrackStatus;
  readonly metadataValid: boolean;
  readonly coverPresent: boolean;
  readonly audioPresent: boolean;
  readonly analysisPresent: boolean;
  readonly analysisUpToDate: boolean;
  readonly renderPresent: boolean;
};

export const toTrackSummaryView = (
  inspection: TrackInspection,
): TrackSummaryView => ({
  slug: inspection.slug,
  title: inspection.metadata?.title ?? null,
  status: inspection.status,
  metadataValid: inspection.metadata !== null,
  coverPresent: inspection.facts.coverExists,
  audioPresent: inspection.facts.beatExists,
  analysisPresent: inspection.facts.analysisExists,
  analysisUpToDate: inspection.facts.analysisUpToDate,
  renderPresent: inspection.facts.outputExists,
});

export type TrackDetailView = TrackSummaryView & {
  readonly metadata: TrackInspection["metadata"];
  readonly validation: ValidationResult;
  readonly assets: {
    readonly cover: string;
    readonly beat: string;
    readonly analysis: string;
    readonly metadata: string;
  };
  readonly render: {
    readonly present: boolean;
    readonly outputLabel: string;
    /** Absolute path, so a UI can reveal it in Finder. */
    readonly outputPath: string | null;
  };
  readonly previewEndpoint: string;
};

export const toTrackDetailView = (
  inspection: TrackInspection,
): TrackDetailView => {
  const locations = trackLocations(inspection.slug);

  return {
    ...toTrackSummaryView(inspection),
    metadata: inspection.metadata,
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
