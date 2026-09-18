import { TrackError, trackIssue, type TrackIssue } from "./errors.ts";
import {
  coerceExportPresetList,
  DEFAULT_RENDER_PRESET_ID,
  parseExportPresetList,
  type RenderPresetId,
} from "../video/renderPresets.ts";
import type { TrackMetadata, TrackMetadataDraft } from "./types.ts";

export const DEFAULT_ARTIST = "Toshi";
export const DEFAULT_SUBTITLE = "Boom bap soul, trap bounce and latin heat.";

export type MetadataValidation = {
  readonly issues: readonly TrackIssue[];
  /** Non-null only when there are no issues. */
  readonly metadata: TrackMetadata | null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The metadata.json a freshly scaffolded track starts with.
 *
 * A new track declares the default format rather than nothing, so its intent is
 * explicit from the moment it exists and never has to be guessed. Callers that
 * know better — the New track panel, `new-track --presets` — pass their own.
 */
export const createDefaultMetadata = (
  title: string,
  exportPresets: readonly RenderPresetId[] = [DEFAULT_RENDER_PRESET_ID],
): TrackMetadataDraft => ({
  title,
  artist: DEFAULT_ARTIST,
  key: "",
  bpm: null,
  subtitle: DEFAULT_SUBTITLE,
  exportPresets,
});

/**
 * Best-effort read of whatever is in a metadata.json, without judging it.
 *
 * Unlike validateTrackMetadata, this never fails: unusable fields fall back to
 * "" / null. That is what lets an editor show a draft's real title and artist —
 * and prefill a form for a track whose file is not yet valid — rather than only
 * being able to display fully-valid metadata.
 *
 * Returns null only when the file does not even contain a JSON object.
 */
export const coerceMetadataDraft = (
  raw: unknown,
): TrackMetadataDraft | null => {
  if (!isPlainObject(raw)) {
    return null;
  }

  return {
    title: typeof raw.title === "string" ? raw.title : "",
    artist: typeof raw.artist === "string" ? raw.artist : "",
    key: typeof raw.key === "string" ? raw.key : "",
    bpm:
      typeof raw.bpm === "number" && Number.isFinite(raw.bpm) && raw.bpm > 0
        ? raw.bpm
        : null,
    subtitle: typeof raw.subtitle === "string" ? raw.subtitle : undefined,
    exportPresets: coerceExportPresetList(raw.exportPresets),
  };
};

/** Stable key order and trailing newline, so rewrites produce clean diffs. */
export const serializeTrackMetadata = (
  metadata: TrackMetadataDraft,
): string => {
  const ordered = {
    title: metadata.title,
    artist: metadata.artist,
    key: metadata.key,
    bpm: metadata.bpm,
    subtitle: metadata.subtitle,
    // Undefined is dropped by JSON.stringify, so an undeclared track keeps a
    // file with no exportPresets key rather than gaining an empty one.
    exportPresets: metadata.exportPresets,
  };

  return `${JSON.stringify(ordered, null, 2)}\n`;
};

/**
 * Collects every problem with a metadata object without throwing, so a UI can
 * show them all at once. `source` is the project-relative path used in messages.
 */
export const validateTrackMetadata = (
  raw: unknown,
  source: string,
): MetadataValidation => {
  if (!isPlainObject(raw)) {
    return {
      issues: [
        trackIssue(
          "METADATA_INVALID",
          `${source} must contain a JSON object.`,
          source,
        ),
      ],
      metadata: null,
    };
  }

  const issues: TrackIssue[] = [];

  const requireString = (field: string): string | null => {
    const value = raw[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      issues.push(
        trackIssue(
          "METADATA_INVALID",
          `${source} is missing a non-empty string field "${field}".`,
          source,
        ),
      );
      return null;
    }
    return value;
  };

  const title = requireString("title");
  const artist = requireString("artist");
  const key = requireString("key");

  const rawBpm = raw.bpm;
  const bpm =
    typeof rawBpm === "number" && Number.isFinite(rawBpm) && rawBpm > 0
      ? rawBpm
      : null;
  if (bpm === null) {
    issues.push(
      trackIssue(
        "METADATA_INVALID",
        `${source} field "bpm" must be a positive number.`,
        source,
      ),
    );
  }

  const rawSubtitle = raw.subtitle;
  if (rawSubtitle !== undefined && typeof rawSubtitle !== "string") {
    issues.push(
      trackIssue(
        "METADATA_INVALID",
        `${source} field "subtitle" must be a string when present.`,
        source,
      ),
    );
  }

  // Undeclared is valid and means "every format"; declared is held to the
  // shared registry, so an unknown or repeated id is a hard error rather than
  // something quietly dropped.
  const rawExportPresets = raw.exportPresets;
  let exportPresets: readonly RenderPresetId[] | undefined;
  if (rawExportPresets !== undefined) {
    const { presets, problems } = parseExportPresetList(rawExportPresets);
    for (const problem of problems) {
      issues.push(trackIssue("METADATA_INVALID", `${source} ${problem}`, source));
    }
    exportPresets = presets ?? undefined;
  }

  if (title === null || artist === null || key === null || bpm === null) {
    return { issues, metadata: null };
  }

  if (issues.length > 0) {
    return { issues, metadata: null };
  }

  return {
    issues,
    metadata: {
      title,
      artist,
      key,
      bpm,
      subtitle: typeof rawSubtitle === "string" ? rawSubtitle : undefined,
      exportPresets,
    },
  };
};

/**
 * Strict variant: returns the metadata or throws the first issue. Used where a
 * single hard failure is the right outcome (the Studio preview, the CLI).
 */
export const parseTrackMetadata = (
  raw: unknown,
  source: string,
): TrackMetadata => {
  const { issues, metadata } = validateTrackMetadata(raw, source);

  if (metadata === null) {
    throw new TrackError(
      issues[0] ??
        trackIssue(
          "METADATA_INVALID",
          `${source} could not be read.`,
          source,
        ),
    );
  }

  return metadata;
};

/**
 * True when metadata still carries the placeholders `new-track` writes.
 * Lets callers say "waiting on key/bpm" instead of "broken".
 */
export const isDraftMetadata = (raw: unknown): boolean => {
  if (!isPlainObject(raw)) {
    return false;
  }

  const looksScaffolded =
    typeof raw.title === "string" && typeof raw.artist === "string";

  return looksScaffolded && (raw.key === "" || raw.bpm === null);
};
