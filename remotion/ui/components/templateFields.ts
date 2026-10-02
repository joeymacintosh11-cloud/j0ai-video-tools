import type { PartialMetadataTemplates } from "../../core/domain/api/views.ts";

/**
 * The seven editable template fields, shared by the global settings panel
 * and a track's own overrides editor, so both walk the same fixed list
 * rather than maintaining two.
 */
export type TemplateFieldDescriptor = {
  readonly platform: "youtube" | "reels" | "instagram-square";
  readonly field: string;
  readonly label: string;
};

export const TEMPLATE_FIELDS: readonly TemplateFieldDescriptor[] = [
  { platform: "youtube", field: "titleTemplate", label: "YouTube title" },
  { platform: "youtube", field: "descriptionTemplate", label: "YouTube description" },
  { platform: "youtube", field: "keywordsTemplate", label: "YouTube keywords (comma-separated)" },
  { platform: "reels", field: "captionTemplate", label: "Reels / TikTok caption" },
  { platform: "reels", field: "hashtagsTemplate", label: "Reels / TikTok hashtags (space-separated)" },
  { platform: "instagram-square", field: "captionTemplate", label: "Instagram caption" },
  { platform: "instagram-square", field: "hashtagsTemplate", label: "Instagram hashtags (space-separated)" },
];

export const templateFieldValue = (
  templates: PartialMetadataTemplates,
  platform: string,
  field: string,
): string | undefined =>
  (templates as Record<string, Record<string, string> | undefined>)[platform]?.[field];

/** Sets (or, with `undefined`, clears) one field, without touching any other. */
export const withTemplateField = (
  templates: PartialMetadataTemplates,
  platform: string,
  field: string,
  value: string | undefined,
): PartialMetadataTemplates => {
  const block = { ...((templates as Record<string, Record<string, string> | undefined>)[platform] ?? {}) };
  if (value === undefined) delete block[field];
  else block[field] = value;
  const next = { ...(templates as Record<string, unknown>) };
  if (Object.keys(block).length > 0) next[platform] = block;
  else delete next[platform];
  return next as PartialMetadataTemplates;
};

/** True once at least one leaf differs between the two (order-independent). */
export const templatesDiffer = (
  a: PartialMetadataTemplates,
  b: PartialMetadataTemplates,
): boolean =>
  TEMPLATE_FIELDS.some(
    ({ platform, field }) => templateFieldValue(a, platform, field) !== templateFieldValue(b, platform, field),
  );
