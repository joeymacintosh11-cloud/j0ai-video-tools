import type { TrackDetailView } from "../../core/domain/api/views.ts";
import {
  buildEngagementPlan,
  DEFAULT_CAPTION_STYLE,
  ENGAGEMENT_PRESET_ID,
  type CaptionStyle,
  type EngagementHookId,
  type EngagementPlan,
  type EngagementPlatform,
  type EngagementSelection,
} from "../../core/domain/content/engagementOptimizer.ts";
import { resolveExportPresets } from "../../core/domain/video/renderPresets.ts";

/**
 * Pure state for the Engagement panel: what to build suggestions from, and
 * the metadata patch a choice saves. Nothing here renders or exports.
 */

/** The plan for a track and platform, from the track view it already has; null while its details are invalid. */
export const engagementPlanFor = (
  track: Pick<TrackDetailView, "metadata" | "exports">,
  platform: EngagementPlatform,
  /** The saved selection to show; the panel passes its confirmed one while the prop lags. */
  selection: EngagementSelection | undefined = track.metadata?.engagement,
): EngagementPlan | null => {
  const metadata = track.metadata;
  const vertical = track.exports.find((output) => output.presetId === ENGAGEMENT_PRESET_ID);
  return buildEngagementPlan({
    subject: metadata === null ? null : { title: metadata.title, artist: metadata.artist, key: metadata.key, bpm: metadata.bpm, subtitle: metadata.subtitle },
    selection,
    platform,
    verticalExport:
      metadata === null
        ? null
        : {
            intended: resolveExportPresets(metadata.exportPresets).includes(ENGAGEMENT_PRESET_ID),
            freshness: vertical?.freshness ?? "missing",
          },
  });
};

/** The whole selection to save when one part changes; the other part is kept. */
export const selectionPatch = (
  current: EngagementSelection | undefined,
  change: { readonly hook?: EngagementHookId; readonly captionStyle?: CaptionStyle },
): { readonly engagement: EngagementSelection } => {
  const hook = change.hook ?? current?.hook;
  return {
    engagement: {
      ...(hook === undefined ? {} : { hook }),
      captionStyle: change.captionStyle ?? current?.captionStyle ?? DEFAULT_CAPTION_STYLE,
    },
  };
};

export const CHECK_MARKS = { pass: "✓", warn: "!", fail: "✗" } as const;

/* ------------------------------------------------------------------ *
 * Saving: one request at a time, never against a stale revision
 * ------------------------------------------------------------------ */

/**
 * The parent's refresh after a save is fire-and-forget, so the track prop can
 * lag behind the write (or never catch up, if the refresh fails). A save's own
 * response is the authoritative post-write state — the same rule MetadataForm
 * follows — so the panel adopts it as "confirmed" and uses its revision and
 * selection until the prop moves on. That makes the sequence safe without
 * waiting on the refresh:
 *
 *  - only one save per track is in flight; a click while one is pending is refused;
 *  - the next save is based on the confirmed revision, never the lagging prop's;
 *  - what is shown as chosen is always a saved state (prop or confirmed), never
 *    a click that has not been confirmed;
 *  - a result for a track the user has left is dropped, and that track's lock
 *    never blocks another track;
 *  - a failed refresh leaves the confirmed state in charge, so nothing is lost.
 */
export type EngagementSync = {
  readonly saving: { readonly slug: string; readonly requestId: number } | null;
  readonly confirmed: {
    readonly slug: string;
    /**
     * Every revision this panel's own saves have moved past (each save's base,
     * and the prop shown when it landed). A refresh showing one of them is
     * late, not news — e.g. the first of two quick saves refreshing after the
     * second has landed. Revisions are content hashes, so equal revision
     * means equal data.
     */
    readonly superseded: readonly (string | null)[];
    readonly revision: string | null;
    readonly engagement: EngagementSelection | undefined;
  } | null;
};

export const INITIAL_ENGAGEMENT_SYNC: EngagementSync = { saving: null, confirmed: null };

export type EngagementSyncAction =
  | { readonly type: "started"; readonly slug: string; readonly requestId: number }
  | {
      readonly type: "succeeded";
      readonly slug: string;
      readonly requestId: number;
      /** The revision the save was sent against. */
      readonly baseRevision: string | null;
      /** The track shown when the response arrived, and its prop revision. */
      readonly currentSlug: string;
      readonly currentRevision: string | null;
      readonly revision: string | null;
      readonly engagement: EngagementSelection | undefined;
    }
  /** `conflict`: the server had a newer revision from elsewhere, so nothing confirmed here is current any more. */
  | { readonly type: "failed"; readonly slug: string; readonly requestId: number; readonly conflict: boolean }
  /** The track prop changed (a refresh arrived, or another track was selected). */
  | { readonly type: "synced"; readonly slug: string; readonly revision: string | null };

export const engagementSyncReducer = (state: EngagementSync, action: EngagementSyncAction): EngagementSync => {
  switch (action.type) {
    case "started":
      return { ...state, saving: { slug: action.slug, requestId: action.requestId } };
    case "succeeded": {
      if (state.saving?.requestId !== action.requestId) return state;
      if (action.slug !== action.currentSlug) return { ...state, saving: null };
      const earlier = state.confirmed?.slug === action.slug ? state.confirmed.superseded : [];
      return {
        saving: null,
        confirmed: {
          slug: action.slug,
          superseded: [...new Set([...earlier, action.baseRevision, action.currentRevision])],
          revision: action.revision,
          engagement: action.engagement,
        },
      };
    }
    case "failed":
      if (state.saving?.requestId !== action.requestId) return state;
      return {
        saving: null,
        confirmed: action.conflict && state.confirmed?.slug === action.slug ? null : state.confirmed,
      };
    case "synced":
      // Showing a revision none of our saves superseded: the prop is the truth again.
      return state.confirmed !== null &&
        (state.confirmed.slug !== action.slug || !state.confirmed.superseded.includes(action.revision))
        ? { ...state, confirmed: null }
        : state;
  }
};

/** What the panel shows and saves against for this track right now. */
export const engagementSyncView = (
  state: EngagementSync,
  track: Pick<TrackDetailView, "slug" | "metadataRevision" | "metadata">,
): { readonly revision: string | null; readonly engagement: EngagementSelection | undefined; readonly locked: boolean } => {
  const confirmed =
    state.confirmed !== null && state.confirmed.slug === track.slug && state.confirmed.superseded.includes(track.metadataRevision)
      ? state.confirmed
      : null;
  return {
    revision: confirmed ? confirmed.revision : track.metadataRevision,
    engagement: confirmed ? confirmed.engagement : track.metadata?.engagement,
    locked: state.saving?.slug === track.slug,
  };
};

/* ------------------------------------------------------------------ *
 * Platform tabs: the WAI-ARIA tabs keyboard pattern
 * ------------------------------------------------------------------ */

/** The tab a key moves to (wrapping), or null for a key tabs do not handle. */
export const nextTabIndex = (current: number, key: string, count: number): number | null => {
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
};
