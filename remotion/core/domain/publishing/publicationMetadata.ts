import type { ContentPackagePlatformEntry } from "../content/contentPackage.ts";
import {
  PUBLICATION_VISIBILITIES,
  type DestinationMetadataRules,
  type PublicationVisibility,
} from "./destinations.ts";
import type { PublishProblem } from "./publishProblems.ts";

/**
 * What a publication says about itself, independent of any platform.
 *
 * Deliberately generic: a title, a body (YouTube's description, an Instagram
 * or TikTok caption), tags (keywords or hashtags, stored without "#"), a
 * visibility, an optional schedule time and an optional cover reference.
 * Destination adapters map these onto their own fields and may add stricter
 * rules (DestinationMetadataRules, PublishDestination.validate); nothing here
 * is shaped around one platform.
 *
 * scheduledAt is data only in this milestone: it is validated and recorded,
 * and nothing executes a schedule.
 */

/** A cover reference, never a path: "the track's own cover art". */
export type PublicationThumbnail = { readonly source: "track-cover" };

export type PublicationMetadata = {
  readonly title: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly visibility: PublicationVisibility;
  readonly scheduledAt: string | null;
  readonly thumbnail: PublicationThumbnail | null;
};

/** Generic ceilings; a destination's own rules may only be stricter. */
export const GENERIC_METADATA_LIMITS = {
  titleMaxLength: 500,
  descriptionMaxLength: 10_000,
  maxTags: 100,
  tagMaxLength: 100,
} as const;

// C0 controls other than tab/newline/carriage return, and DEL.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const invalid = (field: string, message: string): PublishProblem => ({
  reason: "publication_metadata_invalid",
  field,
  message,
});

/** Tags are stored bare: "#lofi" and "lofi" are the same tag. */
export const normalizeTag = (tag: string): string => tag.trim().replace(/^#+/, "").trim();

export type MetadataValidation = {
  /** Normalised metadata when the generic rules pass; null otherwise. */
  readonly metadata: PublicationMetadata | null;
  readonly problems: readonly PublishProblem[];
};

/**
 * Checks untrusted input against the generic rules and normalises it
 * (trimmed text, bare de-duplicated tags, defaults for absent optional fields).
 * Every problem is reported at once, so a form can mark each field.
 */
export const validatePublicationMetadata = (raw: unknown): MetadataValidation => {
  const problems: PublishProblem[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { metadata: null, problems: [invalid("metadata", "Publication metadata must be an object.")] };
  }
  const value = raw as Record<string, unknown>;

  const text = (field: "title" | "description", max: number, required: boolean): string => {
    const input = value[field];
    if (input === undefined || input === null) {
      if (required) problems.push(invalid(field, `A ${field} is required.`));
      return "";
    }
    if (typeof input !== "string") {
      problems.push(invalid(field, `${field} must be text.`));
      return "";
    }
    const trimmed = input.trim();
    if (required && trimmed.length === 0) problems.push(invalid(field, `A ${field} is required.`));
    if (trimmed.length > max) problems.push(invalid(field, `${field} is ${trimmed.length} characters; the limit is ${max}.`));
    if (CONTROL.test(trimmed)) problems.push(invalid(field, `${field} contains control characters.`));
    return trimmed;
  };

  const title = text("title", GENERIC_METADATA_LIMITS.titleMaxLength, true);
  if (title.includes("\n")) problems.push(invalid("title", "title must be a single line."));
  const description = text("description", GENERIC_METADATA_LIMITS.descriptionMaxLength, false);

  let tags: string[] = [];
  if (value.tags !== undefined && value.tags !== null) {
    if (!Array.isArray(value.tags) || value.tags.some((tag) => typeof tag !== "string")) {
      problems.push(invalid("tags", "tags must be a list of text."));
    } else {
      const seen = new Set<string>();
      for (const tag of (value.tags as string[]).map(normalizeTag)) {
        if (tag.length === 0) continue;
        if (tag.length > GENERIC_METADATA_LIMITS.tagMaxLength) problems.push(invalid("tags", `Tag "${tag.slice(0, 20)}…" is too long.`));
        if (CONTROL.test(tag) || tag.includes("\n")) problems.push(invalid("tags", "Tags must be single-line text."));
        const key = tag.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          tags.push(tag);
        }
      }
      if (tags.length > GENERIC_METADATA_LIMITS.maxTags) {
        problems.push(invalid("tags", `${tags.length} tags; the limit is ${GENERIC_METADATA_LIMITS.maxTags}.`));
        tags = tags.slice(0, GENERIC_METADATA_LIMITS.maxTags);
      }
    }
  }

  let visibility: PublicationVisibility = "private";
  if (value.visibility !== undefined) {
    if (!PUBLICATION_VISIBILITIES.includes(value.visibility as PublicationVisibility)) {
      problems.push(invalid("visibility", `visibility must be one of ${PUBLICATION_VISIBILITIES.join(", ")}.`));
    } else {
      visibility = value.visibility as PublicationVisibility;
    }
  }

  let scheduledAt: string | null = null;
  if (value.scheduledAt !== undefined && value.scheduledAt !== null) {
    if (typeof value.scheduledAt !== "string" || !ISO_INSTANT.test(value.scheduledAt) || !Number.isFinite(Date.parse(value.scheduledAt))) {
      problems.push(invalid("scheduledAt", "scheduledAt must be an ISO 8601 date-time with a time zone, e.g. 2026-11-01T18:00:00Z."));
    } else {
      scheduledAt = new Date(Date.parse(value.scheduledAt)).toISOString();
    }
  }

  let thumbnail: PublicationThumbnail | null = null;
  if (value.thumbnail !== undefined && value.thumbnail !== null) {
    const source = (value.thumbnail as { source?: unknown })?.source;
    if (source !== "track-cover") {
      problems.push(invalid("thumbnail", 'thumbnail must be { "source": "track-cover" } or null.'));
    } else {
      thumbnail = { source: "track-cover" };
    }
  }

  return problems.length > 0
    ? { metadata: null, problems }
    : { metadata: { title, description, tags, visibility, scheduledAt, thumbnail }, problems };
};

/** A destination's own, stricter rules, applied to already-valid generic metadata. */
export const destinationMetadataProblems = (
  metadata: PublicationMetadata,
  rules: DestinationMetadataRules,
  capabilities: { readonly thumbnail: boolean; readonly scheduling: boolean },
  destinationName: string,
): readonly PublishProblem[] => {
  const problems: PublishProblem[] = [];
  if (metadata.title.length > rules.titleMaxLength)
    problems.push(invalid("title", `${destinationName} allows titles up to ${rules.titleMaxLength} characters (this one is ${metadata.title.length}).`));
  if (metadata.description.length > rules.descriptionMaxLength)
    problems.push(invalid("description", `${destinationName} allows up to ${rules.descriptionMaxLength} characters of description.`));
  if (metadata.tags.length > rules.maxTags)
    problems.push(invalid("tags", `${destinationName} allows up to ${rules.maxTags} tags (this has ${metadata.tags.length}).`));
  if (metadata.tags.some((tag) => tag.length > rules.tagMaxLength))
    problems.push(invalid("tags", `${destinationName} allows tags up to ${rules.tagMaxLength} characters.`));
  if (!rules.visibilities.includes(metadata.visibility))
    problems.push(invalid("visibility", `${destinationName} does not support "${metadata.visibility}" visibility.`));
  if (metadata.thumbnail !== null && !capabilities.thumbnail)
    problems.push(invalid("thumbnail", `${destinationName} does not accept a thumbnail.`));
  if (metadata.scheduledAt !== null && !capabilities.scheduling)
    problems.push(invalid("scheduledAt", `${destinationName} does not support scheduled publication.`));
  return problems;
};

/**
 * Starting metadata for a publication, from a content package's resolved
 * copy for one platform — the same text "Copy" already gives the operator.
 * A suggestion only: the publish request carries whatever the operator
 * finally submits, and the package itself is never changed.
 */
export const seedPublicationMetadata = (
  entry: Pick<ContentPackagePlatformEntry, "title" | "description" | "caption" | "keywords" | "hashtags">,
  fallbackTitle: string,
): PublicationMetadata => {
  const caption = entry.caption ?? "";
  const firstLine = caption.split("\n")[0]?.trim() ?? "";
  return {
    title: (entry.title ?? (firstLine || fallbackTitle)).slice(0, GENERIC_METADATA_LIMITS.titleMaxLength),
    description: entry.description ?? caption,
    tags: [...new Set([...(entry.keywords ?? []), ...(entry.hashtags ?? [])].map(normalizeTag).filter((tag) => tag.length > 0))],
    visibility: "private",
    scheduledAt: null,
    thumbnail: null,
  };
};
