import { PLATFORM_PROFILES, platformFilename, type PlatformId } from "./platformProfiles.ts";

/**
 * Deterministic platform-facing text, generated from a track's own metadata.
 *
 * No external AI calls, nothing cached or persisted: every field here is a
 * pure function of the same title/artist/key/bpm/subtitle fields the
 * visualizer itself renders, so the text can never drift from the track and
 * never needs its own freshness tracking — it is simply recomputed on every
 * read. Titles/keys/BPM are the values that are actually burned into the
 * video; this module only ever *reads* them, never decides what to render.
 */

export type PlatformMetadataSubject = {
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: number;
  readonly subtitle?: string;
};

export type PlatformMetadata = {
  readonly platformId: PlatformId;
  /** Descriptive filename alias, e.g. "ghetto-geek-youtube.mp4". */
  readonly filename: string;
  /** YouTube only. */
  readonly title: string | null;
  /** YouTube only. */
  readonly description: string | null;
  /** YouTube only. */
  readonly keywords: readonly string[] | null;
  /** Reels/TikTok and Instagram only. */
  readonly caption: string | null;
};

/** "F Minor · 100 BPM" — the fallback tagline when a track has no subtitle. */
const keyBpmTagline = (subject: PlatformMetadataSubject): string =>
  `${subject.key} · ${subject.bpm} BPM`;

const tagline = (subject: PlatformMetadataSubject): string =>
  subject.subtitle?.trim() || keyBpmTagline(subject);

const youtubeTitle = (subject: PlatformMetadataSubject): string =>
  `${subject.title} | ${tagline(subject)} | ${subject.artist}`;

const youtubeDescription = (subject: PlatformMetadataSubject): string => {
  const lines = [
    `${subject.title} by ${subject.artist}.`,
    "",
    `Key: ${subject.key}`,
    `BPM: ${subject.bpm}`,
  ];

  if (subject.subtitle?.trim()) {
    lines.push("", subject.subtitle.trim());
  }

  lines.push("", `Produced by ${subject.artist}.`);

  return lines.join("\n");
};

/** Lowercase, hyphenated, safe as a single keyword/tag token. */
const tagify = (value: string): string =>
  value
    .toLowerCase()
    .trim()
    .replace(/\s+/gu, "-");

const youtubeKeywords = (subject: PlatformMetadataSubject): readonly string[] => {
  const candidates = [
    tagify(subject.artist),
    `${subject.bpm}bpm`,
    tagify(subject.key),
    "type-beat",
    "toshi",
  ];

  // Dedup while keeping the first occurrence's order — an artist named "Toshi"
  // should not produce the tag twice.
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const candidate of candidates) {
    if (candidate.length === 0 || seen.has(candidate)) continue;
    seen.add(candidate);
    keywords.push(candidate);
  }
  return keywords;
};

/** Reels/TikTok and Instagram share the same short caption shape. */
const shortCaption = (subject: PlatformMetadataSubject): string => {
  const head = `${subject.title} — ${subject.artist} (${subject.key}, ${subject.bpm} BPM)`;
  return subject.subtitle?.trim() ? `${head} — ${subject.subtitle.trim()}` : head;
};

/**
 * Builds one platform's metadata for a track.
 *
 * Pure: the same slug/platform/subject always produces the same text, so a
 * package view never needs to store or cache this — it is generated fresh on
 * every read, exactly like the rest of the package.
 */
export const buildPlatformMetadata = (
  slug: string,
  platformId: PlatformId,
  subject: PlatformMetadataSubject,
): PlatformMetadata => {
  const profile = PLATFORM_PROFILES[platformId];
  const filename = platformFilename(slug, platformId);

  if (profile.supportsDescription) {
    return {
      platformId,
      filename,
      title: youtubeTitle(subject),
      description: youtubeDescription(subject),
      keywords: youtubeKeywords(subject),
      caption: null,
    };
  }

  return {
    platformId,
    filename,
    title: null,
    description: null,
    keywords: null,
    caption: shortCaption(subject),
  };
};
