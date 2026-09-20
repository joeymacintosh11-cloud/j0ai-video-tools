import { TrackError, trackIssue } from "../tracks/errors.ts";

/**
 * Editable metadata templates for the content package's generated copy.
 *
 * Pure, browser-safe, dependency-free — exactly like renderPresets.ts and
 * platformProfiles.ts. Plain whitelisted-placeholder substitution only: no
 * eval, no Function constructor, no expressions, no conditionals, no loops,
 * no filesystem or network access. A template is never anything more than a
 * string with `{placeholder}` tokens in it.
 *
 * Precedence, resolved per field (never per whole platform block):
 *
 *   per-track override  ->  global template  ->  built-in default
 *
 * so a track that only overrides its YouTube title still gets the global (or
 * built-in) YouTube description, and its Reels/Instagram copy is untouched.
 */

/* ------------------------------------------------------------------ *
 * Placeholders
 * ------------------------------------------------------------------ */

/**
 * The whitelist. `tagline` and `subtitleSuffix` are the two derived values
 * that let the built-in defaults reproduce, byte for byte, the behavior the
 * hand-written template functions had before this module existed — a
 * subtitle-or-key/BPM fallback for a title, and an optional " — subtitle"
 * suffix for a caption. Both are fixed, non-conditional lookups (exactly
 * like `{bpm}` is a fixed lookup that happens to format a number) — there is
 * no conditional syntax in the template language itself, and a user cannot
 * write one.
 */
export const PLACEHOLDER_KEYS = [
  "title",
  "artist",
  "key",
  "bpm",
  "subtitle",
  "slug",
  "platform",
  "filename",
  "tagline",
  "subtitleSuffix",
] as const;

export type PlaceholderKey = (typeof PLACEHOLDER_KEYS)[number];

export type PlaceholderValues = Readonly<Record<PlaceholderKey, string>>;

export const isPlaceholderKey = (value: string): value is PlaceholderKey =>
  (PLACEHOLDER_KEYS as readonly string[]).includes(value);

/** A template longer than this is treated as structurally invalid, not just long copy. */
export const MAX_TEMPLATE_LENGTH = 2000;

/* ------------------------------------------------------------------ *
 * The renderer
 * ------------------------------------------------------------------ */

const PLACEHOLDER_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g;

// `{{` / `}}` are a literal-brace escape, handled as two string passes before
// and after substitution rather than inside the placeholder regex, so there
// is exactly one well-defined rule ("double the brace") instead of any
// lookahead/lookbehind ambiguity about what counts as "escaped".
const LBRACE_SENTINEL = "\u0000TOSHI_LBRACE\u0000";
const RBRACE_SENTINEL = "\u0000TOSHI_RBRACE\u0000";

const escapeLiteralBraces = (template: string): string =>
  template.split("{{").join(LBRACE_SENTINEL).split("}}").join(RBRACE_SENTINEL);

const restoreLiteralBraces = (text: string): string =>
  text.split(LBRACE_SENTINEL).join("{").split(RBRACE_SENTINEL).join("}");

/**
 * Rendered text is trimmed, and runs of three or more newlines are capped at
 * one blank line (two newlines). This is not a conditional: it is a single,
 * always-applied normalization, the same for every template — and it is what
 * lets an optional field like `{subtitle}` resolve to an empty string
 * without leaving a stray blank paragraph where the value would have been.
 * See metadataTemplates docs (handoff §50.5/§50.6) for the exact reasoning.
 */
const normalizeRenderedText = (text: string): string =>
  text.replace(/\n{3,}/g, "\n\n").trim();

export type TemplateScan = {
  readonly known: readonly PlaceholderKey[];
  readonly unknown: readonly string[];
};

/** Which placeholders a template references, ignoring `{{literal}}` text. */
export const scanTemplatePlaceholders = (template: string): TemplateScan => {
  const escaped = escapeLiteralBraces(template);
  const known = new Set<PlaceholderKey>();
  const unknown: string[] = [];

  for (const match of escaped.matchAll(PLACEHOLDER_PATTERN)) {
    const name = match[1];
    if (isPlaceholderKey(name)) {
      known.add(name);
    } else if (!unknown.includes(name)) {
      unknown.push(name);
    }
  }

  return { known: [...known], unknown };
};

export type TemplateRenderResult = {
  readonly text: string;
  /**
   * Unrecognized `{word}` tokens found while rendering. Left in the output
   * literally (never swallowed, never thrown) — validation is what stops an
   * unknown placeholder from being saved in the first place; the renderer
   * itself stays defensive rather than trusting every caller pre-validated.
   */
  readonly unknownPlaceholders: readonly string[];
};

/**
 * Deterministic, pure, whitelist-only substitution. No eval, no Function
 * constructor, no shell/path interpolation, no HTML execution — a template is
 * plain text in, plain text out.
 */
export const renderTemplate = (
  template: string,
  values: PlaceholderValues,
): TemplateRenderResult => {
  const escaped = escapeLiteralBraces(template);
  const unknownPlaceholders: string[] = [];

  const substituted = escaped.replace(PLACEHOLDER_PATTERN, (whole, name: string) => {
    if (isPlaceholderKey(name)) {
      return values[name];
    }
    if (!unknownPlaceholders.includes(name)) unknownPlaceholders.push(name);
    return whole;
  });

  return {
    text: normalizeRenderedText(restoreLiteralBraces(substituted)),
    unknownPlaceholders,
  };
};

/* ------------------------------------------------------------------ *
 * The template model
 * ------------------------------------------------------------------ */

export const CONTENT_METADATA_TEMPLATES_SCHEMA_VERSION = 1;

export type YoutubeTemplateFields = {
  readonly titleTemplate: string;
  readonly descriptionTemplate: string;
  readonly keywordsTemplate: string;
};

export type CaptionTemplateFields = {
  readonly captionTemplate: string;
  readonly hashtagsTemplate: string;
};

/** Keyed by platform id, so there is no second "instagram" vs "instagram-square" spelling anywhere. */
export type MetadataTemplates = {
  readonly youtube: YoutubeTemplateFields;
  readonly reels: CaptionTemplateFields;
  readonly "instagram-square": CaptionTemplateFields;
};

export type PartialMetadataTemplates = {
  readonly youtube?: Partial<YoutubeTemplateFields>;
  readonly reels?: Partial<CaptionTemplateFields>;
  readonly "instagram-square"?: Partial<CaptionTemplateFields>;
};

const PLATFORM_TEMPLATE_KEYS = ["youtube", "reels", "instagram-square"] as const;
const YOUTUBE_FIELD_KEYS = [
  "titleTemplate",
  "descriptionTemplate",
  "keywordsTemplate",
] as const;
const CAPTION_FIELD_KEYS = ["captionTemplate", "hashtagsTemplate"] as const;

const fieldKeysFor = (
  platform: (typeof PLATFORM_TEMPLATE_KEYS)[number],
): readonly string[] => (platform === "youtube" ? YOUTUBE_FIELD_KEYS : CAPTION_FIELD_KEYS);

/**
 * Current Toshi brand copy, preserved exactly from the hand-written template
 * functions this module replaces — see the placeholder whitelist's doc
 * comment for how `{tagline}`/`{subtitleSuffix}` make that possible without
 * any conditional syntax. Verified byte-for-byte against the previous
 * implementation in tests, both with and without a subtitle.
 */
export const BUILT_IN_DEFAULT_TEMPLATES: MetadataTemplates = {
  youtube: {
    titleTemplate: "{title} | {tagline} | {artist}",
    descriptionTemplate:
      "{title} by {artist}.\n\nKey: {key}\nBPM: {bpm}\n\n{subtitle}\n\nProduced by {artist}.",
    keywordsTemplate: "{artist}, {bpm}bpm, {key}, type-beat, toshi",
  },
  reels: {
    captionTemplate: "{title} — {artist} ({key}, {bpm} BPM){subtitleSuffix}",
    hashtagsTemplate: "#{artist} #TypeBeat #ToshiBeats",
  },
  "instagram-square": {
    captionTemplate: "{title} — {artist} ({key}, {bpm} BPM){subtitleSuffix}",
    hashtagsTemplate: "#{artist} #TypeBeat #ToshiBeats",
  },
};

/**
 * Precedence, per field: track override, then global template, then
 * built-in default. Pure — the caller (server route, CLI) is responsible for
 * gathering the global settings and the track's own overrides; this module
 * has no idea where either came from.
 */
export const resolveMetadataTemplates = (
  global?: PartialMetadataTemplates | null,
  track?: PartialMetadataTemplates | null,
): MetadataTemplates => ({
  youtube: {
    titleTemplate:
      track?.youtube?.titleTemplate ??
      global?.youtube?.titleTemplate ??
      BUILT_IN_DEFAULT_TEMPLATES.youtube.titleTemplate,
    descriptionTemplate:
      track?.youtube?.descriptionTemplate ??
      global?.youtube?.descriptionTemplate ??
      BUILT_IN_DEFAULT_TEMPLATES.youtube.descriptionTemplate,
    keywordsTemplate:
      track?.youtube?.keywordsTemplate ??
      global?.youtube?.keywordsTemplate ??
      BUILT_IN_DEFAULT_TEMPLATES.youtube.keywordsTemplate,
  },
  reels: {
    captionTemplate:
      track?.reels?.captionTemplate ??
      global?.reels?.captionTemplate ??
      BUILT_IN_DEFAULT_TEMPLATES.reels.captionTemplate,
    hashtagsTemplate:
      track?.reels?.hashtagsTemplate ??
      global?.reels?.hashtagsTemplate ??
      BUILT_IN_DEFAULT_TEMPLATES.reels.hashtagsTemplate,
  },
  "instagram-square": {
    captionTemplate:
      track?.["instagram-square"]?.captionTemplate ??
      global?.["instagram-square"]?.captionTemplate ??
      BUILT_IN_DEFAULT_TEMPLATES["instagram-square"].captionTemplate,
    hashtagsTemplate:
      track?.["instagram-square"]?.hashtagsTemplate ??
      global?.["instagram-square"]?.hashtagsTemplate ??
      BUILT_IN_DEFAULT_TEMPLATES["instagram-square"].hashtagsTemplate,
  },
});

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * One template field, checked structurally: a string, not absurdly long, and
 * built only from whitelisted placeholders. Never judges the copy itself —
 * platform-length guidance is advisory and lives in the UI preview, not here.
 */
export const validateTemplateString = (
  value: unknown,
  label: string,
): { readonly value: string | undefined; readonly problems: readonly string[] } => {
  if (typeof value !== "string") {
    return { value: undefined, problems: [`"${label}" must be a string.`] };
  }
  if (value.length > MAX_TEMPLATE_LENGTH) {
    return {
      value: undefined,
      problems: [`"${label}" must be at most ${MAX_TEMPLATE_LENGTH} characters.`],
    };
  }
  const { unknown } = scanTemplatePlaceholders(value);
  if (unknown.length > 0) {
    return {
      value: undefined,
      problems: [
        `"${label}" uses unknown placeholder(s): ${unknown.map((name) => `{${name}}`).join(", ")}. ` +
          `Expected one of: ${PLACEHOLDER_KEYS.map((key) => `{${key}}`).join(", ")}.`,
      ],
    };
  }
  return { value, problems: [] };
};

/**
 * Strict parse of a whole/partial templates object: every known field
 * validated, every unknown platform or field key rejected outright. Used for
 * a track's `contentMetadataOverrides`, which is always replaced as a whole
 * object (never deep-merged patch-of-a-patch) — the same convention
 * `exportPresets` already uses.
 */
export const parseMetadataTemplates = (
  raw: unknown,
  label = "contentMetadataOverrides",
): { readonly templates: PartialMetadataTemplates | null; readonly problems: readonly string[] } => {
  if (raw === undefined || raw === null) {
    return { templates: null, problems: [] };
  }
  if (!isPlainObject(raw)) {
    return { templates: null, problems: [`"${label}" must be an object.`] };
  }

  const problems: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!(PLATFORM_TEMPLATE_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `"${label}.${key}" is not a known platform. Expected one of: ${PLATFORM_TEMPLATE_KEYS.join(", ")}.`,
      );
    }
  }

  const result: Record<string, Record<string, string>> = {};

  for (const platform of PLATFORM_TEMPLATE_KEYS) {
    const block = raw[platform];
    if (block === undefined) continue;
    if (!isPlainObject(block)) {
      problems.push(`"${label}.${platform}" must be an object.`);
      continue;
    }

    const fieldKeys = fieldKeysFor(platform);
    for (const key of Object.keys(block)) {
      if (!fieldKeys.includes(key)) {
        problems.push(
          `"${label}.${platform}.${key}" is not a known field for ${platform}. Expected one of: ${fieldKeys.join(", ")}.`,
        );
      }
    }

    const fields: Record<string, string> = {};
    for (const fieldKey of fieldKeys) {
      const value = block[fieldKey];
      if (value === undefined) continue;
      const { value: validated, problems: fieldProblems } = validateTemplateString(
        value,
        `${label}.${platform}.${fieldKey}`,
      );
      problems.push(...fieldProblems);
      if (validated !== undefined) fields[fieldKey] = validated;
    }
    if (Object.keys(fields).length > 0) result[platform] = fields;
  }

  if (problems.length > 0) {
    return { templates: null, problems };
  }

  return {
    templates: Object.keys(result).length > 0 ? (result as PartialMetadataTemplates) : null,
    problems: [],
  };
};

/**
 * Best-effort read for prefilling an editor from a track whose file may not
 * yet be fully valid — mirrors coerceExportPresetList(). Unusable entries are
 * dropped rather than reported.
 */
export const coerceMetadataTemplates = (
  raw: unknown,
): PartialMetadataTemplates | undefined => {
  if (!isPlainObject(raw)) return undefined;

  const result: Record<string, Record<string, string>> = {};
  for (const platform of PLATFORM_TEMPLATE_KEYS) {
    const block = raw[platform];
    if (!isPlainObject(block)) continue;
    const fields: Record<string, string> = {};
    for (const fieldKey of fieldKeysFor(platform)) {
      const value = block[fieldKey];
      if (typeof value === "string" && value.length <= MAX_TEMPLATE_LENGTH) {
        const { unknown } = scanTemplatePlaceholders(value);
        if (unknown.length === 0) fields[fieldKey] = value;
      }
    }
    if (Object.keys(fields).length > 0) result[platform] = fields;
  }

  return Object.keys(result).length > 0 ? (result as PartialMetadataTemplates) : undefined;
};

/**
 * A global-settings PATCH: each leaf is a validated string (set it), `null`
 * (reset this one field to the built-in default), or omitted (leave alone).
 * Distinct from PartialMetadataTemplates on purpose — resetting one field and
 * simply not mentioning it are different operations (§ handoff, "Reset /
 * clear override").
 */
export type MetadataTemplatesResetPatch = {
  readonly youtube?: {
    readonly titleTemplate?: string | null;
    readonly descriptionTemplate?: string | null;
    readonly keywordsTemplate?: string | null;
  };
  readonly reels?: {
    readonly captionTemplate?: string | null;
    readonly hashtagsTemplate?: string | null;
  };
  readonly "instagram-square"?: {
    readonly captionTemplate?: string | null;
    readonly hashtagsTemplate?: string | null;
  };
};

export const parseMetadataTemplatesResetPatch = (
  raw: unknown,
  label = "templates",
): {
  readonly patch: MetadataTemplatesResetPatch | null;
  readonly problems: readonly string[];
} => {
  if (raw === undefined || raw === null) {
    return { patch: null, problems: [] };
  }
  if (!isPlainObject(raw)) {
    return { patch: null, problems: [`"${label}" must be an object.`] };
  }

  const problems: string[] = [];

  for (const key of Object.keys(raw)) {
    if (!(PLATFORM_TEMPLATE_KEYS as readonly string[]).includes(key)) {
      problems.push(
        `"${label}.${key}" is not a known platform. Expected one of: ${PLATFORM_TEMPLATE_KEYS.join(", ")}.`,
      );
    }
  }

  const result: Record<string, Record<string, string | null>> = {};

  for (const platform of PLATFORM_TEMPLATE_KEYS) {
    const block = raw[platform];
    if (block === undefined) continue;
    if (!isPlainObject(block)) {
      problems.push(`"${label}.${platform}" must be an object.`);
      continue;
    }

    const fieldKeys = fieldKeysFor(platform);
    for (const key of Object.keys(block)) {
      if (!fieldKeys.includes(key)) {
        problems.push(
          `"${label}.${platform}.${key}" is not a known field for ${platform}. Expected one of: ${fieldKeys.join(", ")}.`,
        );
      }
    }

    const fields: Record<string, string | null> = {};
    for (const fieldKey of fieldKeys) {
      const value = block[fieldKey];
      if (value === undefined) continue;
      if (value === null) {
        fields[fieldKey] = null; // explicit reset
        continue;
      }
      const { value: validated, problems: fieldProblems } = validateTemplateString(
        value,
        `${label}.${platform}.${fieldKey}`,
      );
      problems.push(...fieldProblems);
      if (validated !== undefined) fields[fieldKey] = validated;
    }
    if (Object.keys(fields).length > 0) result[platform] = fields;
  }

  if (problems.length > 0) {
    return { patch: null, problems };
  }

  return {
    patch: Object.keys(result).length > 0 ? (result as MetadataTemplatesResetPatch) : null,
    problems: [],
  };
};

/** Applies a reset-patch to a stored partial: string sets, null deletes, omitted keeps. */
export const applyMetadataTemplatesResetPatch = (
  current: PartialMetadataTemplates,
  patch: MetadataTemplatesResetPatch,
): PartialMetadataTemplates => {
  const result: Record<string, Record<string, string>> = {};

  for (const platform of PLATFORM_TEMPLATE_KEYS) {
    const currentBlock = (current as Record<string, Record<string, string> | undefined>)[platform] ?? {};
    const patchBlock = (patch as Record<string, Record<string, string | null> | undefined>)[platform] ?? {};
    const fields: Record<string, string> = { ...currentBlock };

    for (const [fieldKey, value] of Object.entries(patchBlock)) {
      if (value === null) delete fields[fieldKey];
      else fields[fieldKey] = value;
    }

    if (Object.keys(fields).length > 0) result[platform] = fields;
  }

  return result as PartialMetadataTemplates;
};

/** Throws TEMPLATE_INVALID with every collected problem, for a caller that wants to fail fast. */
export const assertNoTemplateProblems = (problems: readonly string[]): void => {
  if (problems.length > 0) {
    throw new TrackError(trackIssue("TEMPLATE_INVALID", problems.join(" ")));
  }
};
