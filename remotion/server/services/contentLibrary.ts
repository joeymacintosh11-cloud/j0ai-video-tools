import {
  buildLibraryEntries,
  libraryTargetKey,
  selectContentLibrary,
  summarizeContentLibrary,
  summarizeTrackFormats,
  type ContentLibraryEntry,
  type ContentLibraryFilter,
  type ContentLibraryProblem,
  type ContentLibraryRecord,
  type ContentLibraryStatus,
  type ContentLibrarySummary,
  type LibraryFormatSummary,
  type LiveExportFacts,
} from "../../core/domain/library/contentLibrary.ts";
import type { DeliveryLogEvent } from "../../core/domain/delivery/deliveryHistory.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { isValidSlug } from "../../core/domain/tracks/slug.ts";
import {
  RENDER_PRESET_LIST,
  isRenderPresetId,
} from "../../core/domain/video/renderPresets.ts";
import { readDeliveryLog } from "../../services/delivery/deliveryHistoryLog.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "../../services/delivery/deliverySettings.ts";
import { readContentLibrary } from "../../services/library/contentLibraryLog.ts";
import { trackExportCoverage } from "../../services/tracks/exportCoverage.ts";
import { readExportManifest } from "../../services/tracks/exportManifest.ts";
import { inspectTrack } from "../../services/tracks/inspectTrack.ts";
import { trackOutputLocation } from "../../services/tracks/trackLocations.ts";

/**
 * Answers questions about the content library: what has been generated, which
 * version of each track/format is on disk now, and what went out.
 *
 * Every filter, ordering and limit is applied here, so the API, the CLI and
 * the UI ask the same questions and get the same answers, and no response is
 * unbounded. Status is derived from the live manifests every time — the
 * library file itself is never rewritten to say a version went out of date.
 *
 * Read-only. Re-exporting is the route's job, and it goes through the normal
 * render queue rather than anything here.
 */

/** Whether per-version delivery facts could be attributed, and if not, why. */
export type LibraryDeliveryAvailability = "not_configured" | "available" | "unavailable";

export type ContentLibraryQueryResult = {
  readonly status: ContentLibraryStatus;
  readonly problems: readonly ContentLibraryProblem[];
  readonly entries: readonly ContentLibraryEntry[];
  readonly matched: number;
  /** Over the whole library, or over one track when the filter names one. */
  readonly summary: ContentLibrarySummary;
  /** Every track in the library, for a filter list — whatever the filter. */
  readonly knownTracks: readonly { readonly slug: string; readonly title: string }[];
  /** Every format in the library, current presets first. */
  readonly knownPresets: readonly { readonly id: string; readonly label: string }[];
  /** Which formats one track has had generated — only when the filter names a track. */
  readonly formats: readonly LibraryFormatSummary[] | null;
  readonly deliveries: LibraryDeliveryAvailability;
};

const KNOWN_PRESETS = RENDER_PRESET_LIST.map((preset) => ({ id: preset.id, label: preset.shortLabel }));

/**
 * What sits at each track/format's canonical path right now, for the slugs
 * the given records mention. A slug that fails validation (only possible in a
 * hand-edited file) is never turned into a path; its records read as missing.
 */
const liveFactsFor = (records: readonly ContentLibraryRecord[]): Map<string, LiveExportFacts> => {
  const facts = new Map<string, LiveExportFacts>();
  const slugs = [...new Set(records.map((record) => record.track.slug))].filter(isValidSlug);

  for (const slug of slugs) {
    let coverage: ReturnType<typeof trackExportCoverage> = [];
    try {
      coverage = trackExportCoverage(slug);
    } catch {
      // Unreadable track: every format reads as not-on-disk below.
    }

    for (const preset of RENDER_PRESET_LIST) {
      const covered = coverage.find((entry) => entry.presetId === preset.id);
      const { manifest } = readExportManifest(trackOutputLocation(slug, preset.id).manifest, slug, preset.id);
      facts.set(libraryTargetKey(slug, preset.id), {
        freshness: covered?.freshness ?? "missing",
        manifest: manifest
          ? {
              generatedAt: manifest.renderedAt,
              inputFingerprint: manifest.inputFingerprint,
              output: manifest.output,
            }
          : null,
      });
    }
  }

  return facts;
};

/** The destination's delivery events, or why there are none to attribute. */
const deliveryEventsFor = async (
  settings: DeliverySettings | undefined,
): Promise<{ readonly events: readonly DeliveryLogEvent[] | null; readonly availability: LibraryDeliveryAvailability }> => {
  try {
    const { root } = resolveDeliveryRoot(settings ?? (await readDeliverySettings()));
    if (root === null) return { events: null, availability: "not_configured" };
    return { events: readDeliveryLog(root).events, availability: "available" };
  } catch {
    // A destination that cannot be read makes delivery facts unknown; it
    // never makes the library itself unavailable.
    return { events: null, availability: "unavailable" };
  }
};

const knownTracksOf = (records: readonly ContentLibraryRecord[]) => {
  const titles = new Map<string, string>();
  // Latest title wins, so a renamed track is listed under its current name.
  for (const record of [...records].sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt))) {
    titles.set(record.track.slug, record.track.title);
  }
  return [...titles.entries()]
    .map(([slug, title]) => ({ slug, title }))
    .sort((a, b) => a.title.localeCompare(b.title) || a.slug.localeCompare(b.slug));
};

const knownPresetsOf = (records: readonly ContentLibraryRecord[]) => [
  ...KNOWN_PRESETS,
  ...[...new Map(
    records
      .filter((record) => !KNOWN_PRESETS.some((preset) => preset.id === record.preset.id))
      .map((record) => [record.preset.id, { id: record.preset.id, label: record.preset.label }]),
  ).values()],
];

export type QueryContentLibraryInput = {
  readonly filter?: ContentLibraryFilter;
  readonly settings?: DeliverySettings;
  readonly root?: string;
};

export const queryContentLibrary = async ({
  filter = {},
  settings,
  root,
}: QueryContentLibraryInput = {}): Promise<ContentLibraryQueryResult> => {
  const read = readContentLibrary(root);
  // Successors and statuses only ever relate records of the same track and
  // format, so narrowing to one track first changes no answer — it only
  // avoids inspecting every other track's exports on disk.
  const scoped = filter.track
    ? read.records.filter((record) => record.track.slug === filter.track)
    : read.records;
  const { events, availability } = await deliveryEventsFor(settings);
  const entries = buildLibraryEntries(scoped, liveFactsFor(scoped), events);
  const selection = selectContentLibrary(entries, filter);

  return {
    status: read.status,
    problems: read.problems,
    entries: selection.entries,
    matched: selection.matched,
    summary: summarizeContentLibrary(entries),
    knownTracks: knownTracksOf(read.records),
    knownPresets: knownPresetsOf(read.records),
    formats: filter.track ? summarizeTrackFormats(entries, filter.track, KNOWN_PRESETS) : null,
    deliveries: availability,
  };
};

export type ContentLibraryRecordDetail = {
  readonly entry: ContentLibraryEntry;
  /** Every version of the same track and format, oldest first. */
  readonly versions: readonly ContentLibraryEntry[];
  /** Whether this version can start a re-export, and if not, why. */
  readonly reexport: { readonly allowed: boolean; readonly reason: string | null };
  readonly deliveries: LibraryDeliveryAvailability;
};

export const getContentLibraryRecord = async (
  recordId: string,
  { settings, root }: { readonly settings?: DeliverySettings; readonly root?: string } = {},
): Promise<ContentLibraryRecordDetail> => {
  const read = readContentLibrary(root);
  const record = read.records.find((candidate) => candidate.recordId === recordId);

  if (record === undefined) {
    throw new TrackError(
      trackIssue("LIBRARY_RECORD_NOT_FOUND", `No content library record "${recordId}".`),
    );
  }

  const sameTrack = read.records.filter((candidate) => candidate.track.slug === record.track.slug);
  const { events, availability } = await deliveryEventsFor(settings);
  const entries = buildLibraryEntries(sameTrack, liveFactsFor(sameTrack), events);
  const entry = entries.find((candidate) => candidate.record.recordId === recordId)!;
  const versions = selectContentLibrary(entries, {
    track: record.track.slug,
    preset: record.preset.id,
    order: "oldest",
    limit: Number.MAX_SAFE_INTEGER,
  }).entries;

  return { entry, versions, reexport: await reexportEligibility(entry), deliveries: availability };
};

/**
 * Whether a re-export can start from this version.
 *
 * Every render uses the track's *current* files, so an old version can never
 * be reproduced — a re-export only ever replaces whatever is on disk now. It
 * is therefore offered only on the version that *is* on disk now, which makes
 * that version the new export's `replaces` record by construction. A
 * superseded or missing version is refused with a pointer to the right one.
 */
export const reexportEligibility = async (
  entry: ContentLibraryEntry,
): Promise<{ readonly allowed: boolean; readonly reason: string | null }> => {
  const { record } = entry;

  if (entry.status === "superseded") {
    return {
      allowed: false,
      reason:
        "A later export replaced this version. Re-export from the current version instead — " +
        "a re-export always renders from the track's current files.",
    };
  }
  if (entry.status === "missing") {
    return {
      allowed: false,
      reason: "This version's file is no longer on disk. Build the format again from the track's Content Package.",
    };
  }
  if (!isValidSlug(record.track.slug) || !isRenderPresetId(record.preset.id)) {
    return { allowed: false, reason: "This format is no longer one this tool can render." };
  }

  const inspection = await inspectTrack(record.track.slug);
  if (!inspection.facts.trackDirExists) {
    return { allowed: false, reason: "This track no longer exists." };
  }
  if (!inspection.validation.ok) {
    return { allowed: false, reason: "The track is not currently valid — fix its validation notes first." };
  }

  return { allowed: true, reason: null };
};
