import type { ExportFreshness } from "../video/exportFreshness.ts";
import { isRendererId, type RendererId } from "../video/renderers.ts";
import { isRenderPresetId, type RenderPresetId } from "../video/renderPresets.ts";
import { RESERVED_DESTINATION_LABELS } from "./destinations.ts";
import { GENERIC_METADATA_LIMITS, normalizeTag, validatePublicationMetadata } from "./publicationMetadata.ts";
import type { PublishProblem } from "./publishProblems.ts";

/**
 * A publication draft: the operator's working copy of what one export will
 * say on one social platform, kept until it is posted.
 *
 * A draft is planning data, not a publish job. It never calls a platform,
 * never creates a job and never touches the export it points at; the
 * platforms here (YouTube, Instagram, TikTok) have no adapter yet, so
 * "posted" is recorded by the operator, not proven by a receipt.
 *
 * Status:
 *   draft   being written; anything may be incomplete
 *   ready   checked: the export is current and the text fits the platform
 *   posted  the operator says it went out (manually, outside this tool)
 *
 * `ready` and `posted` are only accepted when publicationDraftProblems finds
 * nothing, so a draft cannot be marked ready against a missing or stale
 * export. Any status may go back to `draft`.
 *
 * Pure and browser-safe. Files and ids live in services/publishing/.
 */

export const PUBLICATION_DRAFT_SCHEMA_VERSION = 1;

export const DRAFT_PLATFORMS = ["youtube", "instagram", "tiktok"] as const;
export type DraftPlatform = (typeof DRAFT_PLATFORMS)[number];

export const DRAFT_PLATFORM_LABELS: Record<DraftPlatform, string> = RESERVED_DESTINATION_LABELS;

export const isDraftPlatform = (value: unknown): value is DraftPlatform =>
  typeof value === "string" && (DRAFT_PLATFORMS as readonly string[]).includes(value);

export const DRAFT_STATUSES = ["draft", "ready", "posted"] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

export const DRAFT_STATUS_LABELS: Record<DraftStatus, string> = {
  draft: "Draft",
  ready: "Ready to post",
  posted: "Posted (manually)",
};

export const isDraftStatus = (value: unknown): value is DraftStatus =>
  typeof value === "string" && (DRAFT_STATUSES as readonly string[]).includes(value);

/**
 * What each platform takes, by format, and the limits a draft is checked
 * against before it can be marked ready. Conservative, documented platform
 * limits; the description is the caption on Instagram and TikTok.
 */
export type DraftPlatformRules = {
  readonly formats: readonly RenderPresetId[];
  readonly titleMaxLength: number;
  readonly descriptionLabel: "Description" | "Caption";
  readonly descriptionMaxLength: number;
  readonly maxHashtags: number;
};

export const DRAFT_PLATFORM_RULES: Record<DraftPlatform, DraftPlatformRules> = {
  youtube: {
    formats: ["youtube-16x9", "vertical-9x16"],
    titleMaxLength: 100,
    descriptionLabel: "Description",
    descriptionMaxLength: 5000,
    maxHashtags: 15,
  },
  instagram: {
    formats: ["vertical-9x16", "square-1x1"],
    titleMaxLength: 100,
    descriptionLabel: "Caption",
    descriptionMaxLength: 2200,
    maxHashtags: 30,
  },
  tiktok: {
    formats: ["vertical-9x16"],
    titleMaxLength: 100,
    descriptionLabel: "Caption",
    descriptionMaxLength: 2200,
    maxHashtags: 30,
  },
};

export type PublicationDraftSource = {
  readonly track: string;
  readonly format: RenderPresetId;
  /** Whose export: explicit, so an After Effects draft never reads a Remotion file. */
  readonly renderer: RendererId;
};

export type PublicationDraft = {
  readonly schemaVersion: number;
  readonly draftId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Bumped on every save; an edit must name the revision it was made from. */
  readonly revision: number;
  readonly platform: DraftPlatform;
  readonly source: PublicationDraftSource;
  readonly title: string;
  readonly description: string;
  /** Bare, de-duplicated, without "#". */
  readonly hashtags: readonly string[];
  readonly status: DraftStatus;
};

/** The editable part of a draft, as a client sends it. */
export type PublicationDraftFields = Pick<PublicationDraft, "platform" | "source" | "title" | "description" | "hashtags" | "status">;

export const PUBLICATION_DRAFT_ID_PATTERN = /^drf_[a-f0-9]{24}$/;

const invalid = (field: string, message: string): PublishProblem => ({
  reason: "publication_metadata_invalid",
  field,
  message,
});

export type DraftFieldsParse =
  | { readonly fields: PublicationDraftFields; readonly problems: readonly [] }
  | { readonly fields: null; readonly problems: readonly PublishProblem[] };

/**
 * Checks untrusted input for a draft's *shape*: known platform, format,
 * renderer and status, text within the generic ceilings, tags normalised.
 * An incomplete draft (an empty title, say) is still a valid draft — it just
 * cannot be marked ready (publicationDraftProblems).
 */
export const parsePublicationDraftFields = (raw: unknown): DraftFieldsParse => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { fields: null, problems: [invalid("draft", "A draft must be an object.")] };
  const value = raw as Record<string, unknown>;
  const problems: PublishProblem[] = [];

  if (!isDraftPlatform(value.platform))
    problems.push(invalid("platform", `platform must be one of ${DRAFT_PLATFORMS.join(", ")}.`));

  const source = value.source as Record<string, unknown> | null | undefined;
  const track = source?.track;
  if (typeof track !== "string" || track.length === 0) problems.push(invalid("source", "source.track must name a track."));
  if (!isRenderPresetId(source?.format)) problems.push(invalid("source", "source.format must be an export format."));
  if (!isRendererId(source?.renderer)) problems.push(invalid("source", "source.renderer must be a renderer id."));

  const status = value.status === undefined ? "draft" : value.status;
  if (!isDraftStatus(status)) problems.push(invalid("status", `status must be one of ${DRAFT_STATUSES.join(", ")}.`));

  const text = (field: "title" | "description", max: number): string => {
    const input = value[field] ?? "";
    if (typeof input !== "string") {
      problems.push(invalid(field, `${field} must be text.`));
      return "";
    }
    const trimmed = input.trim();
    if (trimmed.length > max) problems.push(invalid(field, `${field} is ${trimmed.length} characters; the limit is ${max}.`));
    return trimmed;
  };
  const title = text("title", GENERIC_METADATA_LIMITS.titleMaxLength);
  const description = text("description", GENERIC_METADATA_LIMITS.descriptionMaxLength);

  let hashtags: string[] = [];
  if (value.hashtags !== undefined) {
    if (!Array.isArray(value.hashtags) || value.hashtags.some((tag) => typeof tag !== "string")) {
      problems.push(invalid("hashtags", "hashtags must be a list of text."));
    } else {
      const seen = new Set<string>();
      for (const tag of (value.hashtags as string[]).map(normalizeTag)) {
        if (tag.length === 0 || seen.has(tag.toLowerCase())) continue;
        if (/\s/.test(tag)) {
          problems.push(invalid("hashtags", `Hashtag "${tag.slice(0, 30)}" contains a space; a hashtag is one word.`));
          continue;
        }
        seen.add(tag.toLowerCase());
        hashtags.push(tag);
      }
      if (hashtags.length > GENERIC_METADATA_LIMITS.maxTags) {
        problems.push(invalid("hashtags", `${hashtags.length} hashtags; the limit is ${GENERIC_METADATA_LIMITS.maxTags}.`));
        hashtags = hashtags.slice(0, GENERIC_METADATA_LIMITS.maxTags);
      }
    }
  }

  if (problems.length > 0) return { fields: null, problems };
  return {
    fields: {
      platform: value.platform as DraftPlatform,
      source: { track: track as string, format: source!.format as RenderPresetId, renderer: source!.renderer as RendererId },
      title,
      description,
      hashtags,
      status: status as DraftStatus,
    },
    problems: [],
  };
};

/** What is known about the draft's export right now (from the renderer's own coverage). */
export type DraftExportFacts = {
  readonly trackValid: boolean;
  readonly freshness: ExportFreshness;
};

/**
 * Everything standing between a draft and "ready": the platform must take
 * the format, the export must be current, and the text must pass the generic
 * publication rules (validatePublicationMetadata) and the platform's limits.
 * Every problem is reported at once.
 */
export const publicationDraftProblems = (
  draft: Pick<PublicationDraft, "platform" | "source" | "title" | "description" | "hashtags">,
  facts: DraftExportFacts,
): readonly PublishProblem[] => {
  const rules = DRAFT_PLATFORM_RULES[draft.platform];
  const name = DRAFT_PLATFORM_LABELS[draft.platform];
  const problems: PublishProblem[] = [];

  if (!rules.formats.includes(draft.source.format))
    problems.push({ reason: "format_unsupported", message: `${name} drafts take ${rules.formats.join(" or ")} exports.` });
  if (!facts.trackValid) problems.push({ reason: "track_invalid", message: `Track "${draft.source.track}" is missing or not valid.` });
  else if (facts.freshness === "missing" || facts.freshness === "invalid")
    problems.push({ reason: "export_missing", message: "This export has not been rendered (or cannot be read). Render it first." });
  else if (facts.freshness === "stale")
    problems.push({ reason: "export_stale", message: "This export is stale. Re-render it before posting." });

  const generic = validatePublicationMetadata({ title: draft.title, description: draft.description, tags: draft.hashtags });
  problems.push(...generic.problems.map((problem) => (problem.field === "tags" ? { ...problem, field: "hashtags" } : problem)));
  if (draft.title.length > rules.titleMaxLength)
    problems.push(invalid("title", `${name} titles are limited to ${rules.titleMaxLength} characters (this one is ${draft.title.length}).`));
  if (draft.description.length > rules.descriptionMaxLength)
    problems.push(invalid("description", `${name} allows up to ${rules.descriptionMaxLength} characters of ${rules.descriptionLabel.toLowerCase()}.`));
  const broken = draft.hashtags.find((tag) => !/^[\p{L}\p{N}_]+$/u.test(tag));
  if (broken !== undefined)
    problems.push(invalid("hashtags", `#${broken} would post as #${broken.split(/[^\p{L}\p{N}_]/u)[0]}: hashtags take letters, digits and underscores only.`));
  if (draft.hashtags.length > rules.maxHashtags)
    problems.push(invalid("hashtags", `${name} allows up to ${rules.maxHashtags} hashtags (this has ${draft.hashtags.length}).`));
  return problems;
};

/** Whether a status may be saved with these problems. Only "draft" tolerates them. */
export const statusAllowed = (status: DraftStatus, problems: readonly PublishProblem[]): boolean =>
  status === "draft" || problems.length === 0;

/** The text an operator pastes: the description, then the hashtags with "#". */
export const draftPostText = (draft: Pick<PublicationDraft, "description" | "hashtags">): string =>
  [draft.description, draft.hashtags.map((tag) => `#${tag}`).join(" ")].filter((part) => part.length > 0).join("\n\n");
