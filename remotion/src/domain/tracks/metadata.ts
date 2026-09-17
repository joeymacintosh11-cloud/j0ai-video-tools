import { TrackError, trackIssue, type TrackIssue } from "./errors.ts";
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

/** The metadata.json a freshly scaffolded track starts with. */
export const createDefaultMetadata = (title: string): TrackMetadataDraft => ({
  title,
  artist: DEFAULT_ARTIST,
  key: "",
  bpm: null,
  subtitle: DEFAULT_SUBTITLE,
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
