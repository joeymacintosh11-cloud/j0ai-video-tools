import {
  BUILT_IN_DEFAULT_TEMPLATES,
  renderTemplate,
  type MetadataTemplates,
  type PlaceholderValues,
} from "./metadataTemplates.ts";
import { PLATFORM_PROFILES, platformFilename, type PlatformId } from "./platformProfiles.ts";

/**
 * Platform-facing text, built by rendering the resolved templates
 * (track override -> global template -> built-in default, already merged by
 * the caller via resolveMetadataTemplates()) against one track's fields.
 *
 * No external AI calls. A pure function of the same title/artist/key/bpm/
 * subtitle fields the visualizer itself renders, so this text can never drift
 * out of sync with the track and needs no freshness tracking of its own — it
 * is simply recomputed on every read, exactly like the rest of the package.
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
  /** Reels/TikTok and Instagram only. */
  readonly hashtags: readonly string[] | null;
};

const placeholderValuesFor = (
  slug: string,
  platformId: PlatformId,
  filename: string,
  subject: PlatformMetadataSubject,
): PlaceholderValues => {
  const subtitle = subject.subtitle?.trim() ?? "";

  return {
    title: subject.title,
    artist: subject.artist,
    key: subject.key,
    bpm: String(subject.bpm),
    subtitle,
    slug,
    platform: PLATFORM_PROFILES[platformId].label,
    filename,
    tagline: subtitle || `${subject.key} · ${subject.bpm} BPM`,
    subtitleSuffix: subtitle ? ` — ${subtitle}` : "",
  };
};

/** Lowercase, hyphenated, safe as a single keyword/tag token. */
const tagify = (value: string): string => value.toLowerCase().trim().replace(/\s+/gu, "-");

/** Comma-separated template output -> a deduplicated, tagified keyword list. */
const splitKeywords = (rendered: string): readonly string[] => {
  const seen = new Set<string>();
  const keywords: string[] = [];
  for (const raw of rendered.split(",")) {
    const token = tagify(raw);
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    keywords.push(token);
  }
  return keywords;
};

/** Whitespace-separated template output -> a hashtag list, presented as typed. */
const splitHashtags = (rendered: string): readonly string[] =>
  rendered.split(/\s+/u).filter((token) => token.length > 0);

/**
 * Builds one platform's metadata for a track.
 *
 * `templates` defaults to the built-in set so an existing caller that has not
 * been updated to resolve global/track templates still gets exactly the
 * product's current default copy.
 */
export const buildPlatformMetadata = (
  slug: string,
  platformId: PlatformId,
  subject: PlatformMetadataSubject,
  templates: MetadataTemplates = BUILT_IN_DEFAULT_TEMPLATES,
): PlatformMetadata => {
  const profile = PLATFORM_PROFILES[platformId];
  const filename = platformFilename(slug, platformId);
  const values = placeholderValuesFor(slug, platformId, filename, subject);

  if (profile.supportsDescription) {
    const t = templates.youtube;
    return {
      platformId,
      filename,
      title: renderTemplate(t.titleTemplate, values).text,
      description: renderTemplate(t.descriptionTemplate, values).text,
      keywords: splitKeywords(renderTemplate(t.keywordsTemplate, values).text),
      caption: null,
      hashtags: null,
    };
  }

  const t = platformId === "reels" ? templates.reels : templates["instagram-square"];
  return {
    platformId,
    filename,
    title: null,
    description: null,
    keywords: null,
    caption: renderTemplate(t.captionTemplate, values).text,
    hashtags: splitHashtags(renderTemplate(t.hashtagsTemplate, values).text),
  };
};
