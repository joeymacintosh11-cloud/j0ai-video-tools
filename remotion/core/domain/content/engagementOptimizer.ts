import type { ExportFreshness } from "../video/exportFreshness.ts";

/**
 * Engagement Optimizer (V1): hooks, caption styles, calls to action and a
 * pre-export checklist for short-form vertical posts.
 *
 * Deterministic templates over the track's own metadata — the same inputs
 * the content package's copy uses (metadataTemplates.ts), and nothing else:
 * no network, no randomness, no model. The same track always gets the same
 * suggestions, so they are testable and reviewable.
 *
 * Copy only. The selected hook is saved with the track (TrackMetadata
 * `engagement`) but is never passed to a renderer: it is not part of
 * VisualizerProps, the After Effects template contract or any export
 * fingerprint, so choosing or changing it never re-renders or stales an
 * export. Putting a hook on screen is a renderer change for a later
 * milestone (see ARCHITECTURE.md).
 *
 * Pure and browser-safe.
 */

/* ------------------------------------------------------------------ *
 * Vocabulary
 * ------------------------------------------------------------------ */

export const ENGAGEMENT_HOOK_IDS = ["tease", "question", "statement"] as const;
export type EngagementHookId = (typeof ENGAGEMENT_HOOK_IDS)[number];

export const CAPTION_STYLES = ["engagement", "discovery", "conversion"] as const;
export type CaptionStyle = (typeof CAPTION_STYLES)[number];

export const CAPTION_STYLE_LABELS: Record<CaptionStyle, string> = {
  engagement: "Engagement — invite comments and saves",
  discovery: "Discovery — reach new listeners",
  conversion: "Conversion — send people to the full beat",
};

/** Short-form vertical platforms; all of them post the 9:16 export. */
export const ENGAGEMENT_PLATFORMS = ["instagram-reels", "tiktok", "youtube-shorts"] as const;
export type EngagementPlatform = (typeof ENGAGEMENT_PLATFORMS)[number];

export const ENGAGEMENT_PLATFORM_LABELS: Record<EngagementPlatform, string> = {
  "instagram-reels": "Instagram Reels",
  tiktok: "TikTok",
  "youtube-shorts": "YouTube Shorts",
};

/** The export format every engagement platform posts. */
export const ENGAGEMENT_PRESET_ID = "vertical-9x16" as const;

const isOneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

export const isEngagementHookId = (value: unknown): value is EngagementHookId => isOneOf(ENGAGEMENT_HOOK_IDS, value);
export const isCaptionStyle = (value: unknown): value is CaptionStyle => isOneOf(CAPTION_STYLES, value);
export const isEngagementPlatform = (value: unknown): value is EngagementPlatform => isOneOf(ENGAGEMENT_PLATFORMS, value);

/* ------------------------------------------------------------------ *
 * The saved selection (TrackMetadata.engagement)
 * ------------------------------------------------------------------ */

export type EngagementSelection = {
  readonly hook?: EngagementHookId;
  readonly captionStyle?: CaptionStyle;
};

/**
 * Lenient read of a stored selection: unknown values are dropped, never an
 * error. An engagement choice must never make a track invalid or block a
 * render, so a hand-edited or newer value simply reads as "not chosen".
 */
export const coerceEngagementSelection = (raw: unknown): EngagementSelection | undefined => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const selection: EngagementSelection = {
    ...(isEngagementHookId(value.hook) ? { hook: value.hook } : {}),
    ...(isCaptionStyle(value.captionStyle) ? { captionStyle: value.captionStyle } : {}),
  };
  return selection.hook === undefined && selection.captionStyle === undefined ? undefined : selection;
};

/** Strict parse of a requested selection (a metadata save): every problem is reported. */
export const parseEngagementSelection = (
  raw: unknown,
): { readonly selection: EngagementSelection | null; readonly problems: readonly string[] } => {
  if (raw === null) return { selection: null, problems: [] };
  if (typeof raw !== "object" || Array.isArray(raw))
    return { selection: null, problems: ['"engagement" must be an object like {"hook": "question", "captionStyle": "engagement"}, or null.'] };
  const value = raw as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of Object.keys(value)) {
    if (key !== "hook" && key !== "captionStyle") problems.push(`"engagement.${key}" is not a known field. Expected hook or captionStyle.`);
  }
  if (value.hook !== undefined && !isEngagementHookId(value.hook))
    problems.push(`"engagement.hook" must be one of ${ENGAGEMENT_HOOK_IDS.join(", ")}.`);
  if (value.captionStyle !== undefined && !isCaptionStyle(value.captionStyle))
    problems.push(`"engagement.captionStyle" must be one of ${CAPTION_STYLES.join(", ")}.`);
  if (value.hook === undefined && value.captionStyle === undefined)
    problems.push('"engagement" names neither hook nor captionStyle; send null to clear the choices.');
  if (problems.length > 0) return { selection: null, problems };
  return { selection: coerceEngagementSelection(value) ?? null, problems: [] };
};

/* ------------------------------------------------------------------ *
 * Inputs
 * ------------------------------------------------------------------ */

/** The track facts suggestions are built from (TrackMetadata's own fields). */
export type EngagementSubject = {
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: number;
  readonly subtitle?: string;
};

/** What is known about the track's 9:16 export, when the caller has it. */
export type VerticalExportFacts = {
  /** The track's exportPresets include 9:16. */
  readonly intended: boolean;
  readonly freshness: ExportFreshness;
};

/* ------------------------------------------------------------------ *
 * Hooks
 * ------------------------------------------------------------------ */

/**
 * A hook is the first thing a viewer reads: on-screen text for the opening
 * second and the caption's first line. Kept to what can be read in about a
 * second.
 */
export const READABLE_HOOK_MAX_WORDS = 8;
export const READABLE_HOOK_MAX_CHARACTERS = 50;

export type EngagementHook = {
  readonly id: EngagementHookId;
  readonly label: string;
  readonly text: string;
  /** Why this angle tends to stop the scroll; shown as guidance. */
  readonly rationale: string;
};

const clean = (value: string | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

export const wordCount = (text: string): number => (text.trim() === "" ? 0 : text.trim().split(/\s+/).length);

/**
 * Characters as a reader counts them: code points, so an emoji or a letter
 * outside the Basic Multilingual Plane is one character, not two UTF-16 units.
 */
export const characterCount = (text: string): number => Array.from(text).length;

export const isReadableHook = (text: string): boolean =>
  characterCount(text) <= READABLE_HOOK_MAX_CHARACTERS && wordCount(text) <= READABLE_HOOK_MAX_WORDS;

/** Ends a sentence once: "Made at 3am" and "Made at 3am." both become "Made at 3am.". */
const asSentence = (text: string): string => (/[.!?…]$/u.test(text) ? text : `${text}.`);

/** The first candidate that is readable in a second, else the shortest. */
const firstReadable = (candidates: readonly string[]): string =>
  candidates.find(isReadableHook) ?? [...candidates].sort((a, b) => a.length - b.length)[0];

export const buildEngagementHooks = (subject: EngagementSubject): readonly EngagementHook[] => {
  const title = clean(subject.title);
  const artist = clean(subject.artist);
  const key = clean(subject.key);
  const subtitle = clean(subject.subtitle);
  const bpm = `${subject.bpm} BPM`;
  return [
    {
      id: "tease",
      label: "Tease the drop",
      text: firstReadable([`Wait for the drop… ${bpm}`, "Wait for the drop…"]),
      rationale: "Promises a payoff, so viewers stay past the first second to get it.",
    },
    {
      id: "question",
      label: "Ask a question",
      text: firstReadable([`Does ${key} at ${bpm} hit different?`, `Does ${key} hit different?`, "Does this hit different?"]),
      rationale: "An open question invites a comment, which platforms read as engagement.",
    },
    {
      id: "statement",
      label: "Name it",
      text: firstReadable([
        ...(subtitle ? [asSentence(subtitle)] : []),
        `${title} — ${artist}`,
        `New ${artist} beat`,
        "New beat out now",
      ]),
      rationale: "Says what this is right away, so the right listeners recognise it and stay.",
    },
  ];
};

/* ------------------------------------------------------------------ *
 * Calls to action
 * ------------------------------------------------------------------ */

/** One CTA per caption style, in each platform's own idiom. */
export const PLATFORM_CTAS: Record<EngagementPlatform, Record<CaptionStyle, string>> = {
  "instagram-reels": {
    engagement: "Save this for your next session.",
    discovery: "Send this to someone who needs a new beat.",
    conversion: "Full beat: link in bio.",
  },
  tiktok: {
    engagement: "Comment the first line you'd write on this.",
    discovery: "Use this sound in your next video.",
    conversion: "Full beat: link in bio.",
  },
  "youtube-shorts": {
    engagement: "Comment your favourite part.",
    discovery: "Subscribe for more beats like this.",
    conversion: "Full beat: link in the description.",
  },
};

/* ------------------------------------------------------------------ *
 * Captions
 * ------------------------------------------------------------------ */

/**
 * Platform guidance the checklist applies. Approximations of how much shows
 * before "more" and of current hashtag advice, not hard platform rules.
 */
export type EngagementPlatformGuidance = {
  /** Characters of the first line shown before truncation (YouTube: the Shorts title limit). */
  readonly firstLineVisible: number;
  readonly captionMaxLength: number;
  readonly recommendedMaxHashtags: number;
  /** Hashtags a post on this platform should carry. */
  readonly requiredHashtags: readonly string[];
};

export const ENGAGEMENT_PLATFORM_GUIDANCE: Record<EngagementPlatform, EngagementPlatformGuidance> = {
  "instagram-reels": { firstLineVisible: 125, captionMaxLength: 2200, recommendedMaxHashtags: 5, requiredHashtags: [] },
  tiktok: { firstLineVisible: 100, captionMaxLength: 2200, recommendedMaxHashtags: 5, requiredHashtags: [] },
  "youtube-shorts": { firstLineVisible: 100, captionMaxLength: 5000, recommendedMaxHashtags: 3, requiredHashtags: ["Shorts"] },
};

/** A hashtag body: letters, digits and underscores only (platforms cut a tag at anything else). */
export const hashtagOf = (value: string): string => value.replace(/[^\p{L}\p{N}_]/gu, "");

/**
 * A musical key as a hashtag, keeping its accidental: "F# Minor" is
 * #FSharpMinor and "B♭ Major" #BFlatMajor — never #FMinor, a different key.
 */
export const keyHashtagOf = (key: string): string =>
  hashtagOf(key.replace(/[#♯]/gu, "Sharp").replace(/♭/gu, "Flat"));

const hashtagsFor = (subject: EngagementSubject, platform: EngagementPlatform, style: CaptionStyle): readonly string[] => {
  const artist = hashtagOf(clean(subject.artist));
  const key = keyHashtagOf(clean(subject.key));
  const byStyle: Record<CaptionStyle, readonly string[]> = {
    engagement: [artist, "TypeBeat", "Beats"],
    discovery: ["TypeBeat", `${subject.bpm}BPM`, key, "Producer", artist],
    conversion: [artist, "TypeBeat", "NewMusic"],
  };
  const { requiredHashtags, recommendedMaxHashtags } = ENGAGEMENT_PLATFORM_GUIDANCE[platform];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const tag of [...requiredHashtags, ...byStyle[style]]) {
    if (tag.length === 0 || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    tags.push(tag);
  }
  return tags.slice(0, recommendedMaxHashtags);
};

export type EngagementCaption = {
  readonly platform: EngagementPlatform;
  readonly style: CaptionStyle;
  /** The full text to paste: hook, body, CTA, hashtags. */
  readonly text: string;
  readonly firstLine: string;
  readonly cta: string;
  /** Without "#". */
  readonly hashtags: readonly string[];
};

const bodyFor = (subject: EngagementSubject, style: CaptionStyle): string => {
  const title = clean(subject.title);
  const artist = clean(subject.artist);
  const key = clean(subject.key);
  switch (style) {
    case "engagement":
      return `${title} by ${artist}. Intro or drop — which part hits hardest?`;
    case "discovery":
      return `${title} by ${artist} · ${key} · ${subject.bpm} BPM`;
    case "conversion":
      return `${title} by ${artist} is out now.`;
  }
};

export const buildEngagementCaption = (
  subject: EngagementSubject,
  hook: EngagementHook,
  platform: EngagementPlatform,
  style: CaptionStyle,
): EngagementCaption => {
  const cta = PLATFORM_CTAS[platform][style];
  const hashtags = hashtagsFor(subject, platform, style);
  const text = [hook.text, bodyFor(subject, style), cta, hashtags.map((tag) => `#${tag}`).join(" ")]
    .filter((part) => part.length > 0)
    .join("\n\n");
  return { platform, style, text, firstLine: hook.text, cta, hashtags };
};

/* ------------------------------------------------------------------ *
 * Pre-export checklist
 * ------------------------------------------------------------------ */

export type ChecklistStatus = "pass" | "warn" | "fail";

export type ChecklistItem = {
  readonly id:
    | "metadata_complete"
    | "hook_selected"
    | "hook_readable"
    | "first_line_visible"
    | "cta_present"
    | "hashtags"
    | "caption_length"
    | "vertical_export";
  readonly label: string;
  readonly status: ChecklistStatus;
  readonly detail: string;
};

export const checklistFor = (input: {
  readonly subject: EngagementSubject | null;
  readonly selectedHook: EngagementHook | null;
  readonly caption: EngagementCaption | null;
  readonly verticalExport: VerticalExportFacts | null;
}): readonly ChecklistItem[] => {
  const { subject, selectedHook, caption, verticalExport } = input;
  const items: ChecklistItem[] = [];
  const add = (id: ChecklistItem["id"], label: string, status: ChecklistStatus, detail: string) =>
    items.push({ id, label, status, detail });

  add(
    "metadata_complete",
    "Track details complete",
    subject === null ? "fail" : "pass",
    subject === null ? "Fix the track's title, artist, key and BPM first; hooks and captions are built from them." : "Title, artist, key and BPM are set.",
  );

  if (selectedHook === null) {
    add("hook_selected", "Hook chosen", "fail", "Choose one of the three hooks; it opens the caption.");
  } else {
    add("hook_selected", "Hook chosen", "pass", `"${selectedHook.text}"`);
    add(
      "hook_readable",
      "Hook readable in about a second",
      isReadableHook(selectedHook.text) ? "pass" : "warn",
      `${wordCount(selectedHook.text)} words, ${characterCount(selectedHook.text)} characters ` +
        `(aim for at most ${READABLE_HOOK_MAX_WORDS} words and ${READABLE_HOOK_MAX_CHARACTERS} characters).`,
    );
  }

  if (caption !== null) {
    const guidance = ENGAGEMENT_PLATFORM_GUIDANCE[caption.platform];
    const platform = ENGAGEMENT_PLATFORM_LABELS[caption.platform];
    add(
      "first_line_visible",
      "First line shows before \"more\"",
      characterCount(caption.firstLine) <= guidance.firstLineVisible ? "pass" : "warn",
      `${characterCount(caption.firstLine)} of about ${guidance.firstLineVisible} characters ${platform} shows.`,
    );
    add(
      "cta_present",
      "Call to action included",
      caption.text.includes(caption.cta) ? "pass" : "fail",
      caption.cta,
    );
    const missing = guidance.requiredHashtags.filter((tag) => !caption.hashtags.some((own) => own.toLowerCase() === tag.toLowerCase()));
    add(
      "hashtags",
      "Hashtags",
      caption.hashtags.length === 0 || missing.length > 0 ? "warn" : caption.hashtags.length > guidance.recommendedMaxHashtags ? "warn" : "pass",
      missing.length > 0
        ? `${platform} posts should include ${missing.map((tag) => `#${tag}`).join(" ")}.`
        : `${caption.hashtags.length} of at most ${guidance.recommendedMaxHashtags} recommended for ${platform}.`,
    );
    add(
      "caption_length",
      "Caption length",
      characterCount(caption.text) <= guidance.captionMaxLength ? "pass" : "fail",
      `${characterCount(caption.text)} of ${guidance.captionMaxLength} characters.`,
    );
  }

  if (verticalExport !== null) {
    const { intended, freshness } = verticalExport;
    const [status, detail]: [ChecklistStatus, string] = !intended
      ? ["warn", "Reels 9:16 is not one of this track's export formats; add it under Track info before exporting."]
      : freshness === "current"
        ? ["pass", "The Reels 9:16 export is current."]
        : freshness === "stale"
          ? ["warn", "The Reels 9:16 export is stale; re-render it before posting."]
          : ["warn", "No current Reels 9:16 export yet; render it before posting."];
    add("vertical_export", "Vertical 9:16 export", status, detail);
  }

  return items;
};

/* ------------------------------------------------------------------ *
 * Everything for one track and platform
 * ------------------------------------------------------------------ */

export type EngagementPlan = {
  readonly hooks: readonly EngagementHook[];
  /** The saved hook, or null when none is chosen yet. */
  readonly selectedHook: EngagementHook | null;
  readonly captionStyle: CaptionStyle;
  readonly platform: EngagementPlatform;
  /** Every caption style for this platform, opening with the selected hook (or the first hook as a preview). */
  readonly captions: Readonly<Record<CaptionStyle, EngagementCaption>>;
  readonly ctas: Readonly<Record<CaptionStyle, string>>;
  readonly checklist: readonly ChecklistItem[];
};

export const DEFAULT_CAPTION_STYLE: CaptionStyle = "engagement";

export const buildEngagementPlan = (input: {
  readonly subject: EngagementSubject | null;
  readonly selection?: EngagementSelection;
  readonly platform: EngagementPlatform;
  readonly verticalExport?: VerticalExportFacts | null;
}): EngagementPlan | null => {
  const { subject, selection, platform } = input;
  const captionStyle = selection?.captionStyle ?? DEFAULT_CAPTION_STYLE;
  if (subject === null) {
    return null;
  }
  const hooks = buildEngagementHooks(subject);
  const selectedHook = hooks.find((hook) => hook.id === selection?.hook) ?? null;
  const opening = selectedHook ?? hooks[0];
  const captions = Object.fromEntries(
    CAPTION_STYLES.map((style) => [style, buildEngagementCaption(subject, opening, platform, style)]),
  ) as Record<CaptionStyle, EngagementCaption>;
  return {
    hooks,
    selectedHook,
    captionStyle,
    platform,
    captions,
    ctas: PLATFORM_CTAS[platform],
    checklist: checklistFor({
      subject,
      selectedHook,
      caption: captions[captionStyle],
      verticalExport: input.verticalExport ?? null,
    }),
  };
};
