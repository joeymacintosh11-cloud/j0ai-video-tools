/**
 * The contract between this adapter and an After Effects template (.aep).
 *
 * Before every render the adapter writes, beside the configured data file:
 *
 *   toshi-render-data.json     the template data (core/domain/video/templateData.ts)
 *   toshi-cover.png            the track's cover
 *   toshi-audio.wav            the track's audio
 *   toshi-waveform-audio.wav   lighter audio for audio-reactive layers
 *   toshi-brand-logo.png       the brand logo
 *   toshi-brand-badge.png      the brand badge
 *
 * A template imports the images and audio once, by these names, as footage.
 * After Effects reloads them from disk every time aerender opens the project,
 * so they always show the track being rendered.
 *
 * Text is different. A real After Effects 2026 render showed
 * `footage("toshi-render-data.json")` found but its `sourceData` and
 * `sourceText` both null, so expressions cannot read the JSON at render time.
 * Instead the bootstrap script reads the staged JSON when it builds the
 * template and writes the text into the layers (templateText). The template
 * is therefore built for one track; it records which in a marker
 * (templateTextMarker), and the adapter refuses to render a template whose
 * marker belongs to another track (templateTextStatus).
 *
 * Pure: the checks take bytes and stream lists, not paths.
 */

/** The data file's default name, beside the project. */
export const TEMPLATE_DATA_FILE_NAME = "toshi-render-data.json";

/** Staged file base names; each keeps its source's extension. */
export const STAGED_ASSET_NAMES = {
  cover: "toshi-cover",
  audio: "toshi-audio",
  waveformAudio: "toshi-waveform-audio",
  brandLogo: "toshi-brand-logo",
  brandBadge: "toshi-brand-badge",
} as const;

/**
 * What a template must use, or its render cannot show the track: the cover
 * and the audio. A template that references neither renders a black, silent
 * video, which is what this check exists to stop. (Text is checked through
 * its marker instead; see templateTextStatus.)
 */
export const REQUIRED_TEMPLATE_FILES = [`${STAGED_ASSET_NAMES.cover}.png`, `${STAGED_ASSET_NAMES.audio}.wav`] as const;

/** The track fields a template shows, as TemplateData's `track` holds them. */
export type TemplateTrackText = {
  readonly title?: unknown;
  readonly artist?: unknown;
  readonly key?: unknown;
  readonly bpm?: unknown;
};

/** The text layers the bootstrap script fills, top to bottom. */
export const TEMPLATE_TEXT_LAYERS = ["Key BPM", "Artist", "Title"] as const;

export type TemplateText = Readonly<Record<(typeof TEMPLATE_TEXT_LAYERS)[number], string>>;

/**
 * The text each layer shows for a track. A missing optional field shows as
 * nothing; key and BPM are joined with " · " when both are there.
 *
 * template/create-toshi-template.jsx has the same rules (a test compares
 * them): it applies them at build time, inside After Effects.
 */
export const templateText = (track: TemplateTrackText): TemplateText => {
  const parts: string[] = [];
  if (track.key) parts.push(String(track.key));
  if (track.bpm) parts.push(`${String(track.bpm)} BPM`);
  return {
    Title: track.title ? String(track.title) : "",
    Artist: track.artist ? String(track.artist) : "",
    "Key BPM": parts.join(" \u00b7 "),
  };
};

/** What every text marker starts with. */
export const TEMPLATE_TEXT_MARKER_PREFIX = "toshi-text-";

/**
 * A short, stable name for a track's text: the prefix and a 32-bit FNV-1a
 * hash, in hex, of the three lines. The bootstrap script writes it into the
 * composition's and the Title layer's comments, computed identically.
 */
export const templateTextMarker = (text: TemplateText): string => {
  const source = `${text.Title}\n${text.Artist}\n${text["Key BPM"]}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
    hash >>>= 0;
  }
  return `${TEMPLATE_TEXT_MARKER_PREFIX}${hash.toString(16).padStart(8, "0")}`;
};

/**
 * The bootstrap's layers, top to bottom as the Timeline shows them. Names are
 * part of the contract: documentation and tests refer to them.
 */
export const TEMPLATE_LAYERS = [
  "Audio",
  "Brand Logo",
  "Waveform",
  "Accent",
  "Key BPM",
  "Artist",
  "Title",
  "Cover",
  "Background",
] as const;

/** Names After Effects stores for its native Audio Waveform effect (match name, display name). */
export const AUDIO_WAVEFORM_EFFECT_NAMES = ["ADBE AudWave", "Audio Waveform"] as const;

const encodings = (text: string): Uint8Array[] => {
  const utf8 = new TextEncoder().encode(text);
  const utf16 = (littleEndian: boolean) => {
    const bytes = new Uint8Array(text.length * 2);
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      bytes[index * 2 + (littleEndian ? 0 : 1)] = code & 0xff;
      bytes[index * 2 + (littleEndian ? 1 : 0)] = code >> 8;
    }
    return bytes;
  };
  return [utf8, utf16(true), utf16(false)];
};

const contains = (haystack: Uint8Array, needle: Uint8Array): boolean => {
  outer: for (let start = 0; start <= haystack.length - needle.length; start++) {
    for (let offset = 0; offset < needle.length; offset++) {
      if (haystack[start + offset] !== needle[offset]) continue outer;
    }
    return true;
  }
  return false;
};

/**
 * Which required files a project never mentions.
 *
 * A project stores each footage item's file path as text (in .aep, inside its
 * binary chunks; in .aepx, as XML), so a file the project does not mention is
 * a file it cannot be using. Searched as UTF-8 and UTF-16 so the check does
 * not depend on how a given After Effects version encodes paths. It proves a
 * file is missing, not that a present one is wired up correctly.
 */
export const missingTemplateFiles = (
  project: Uint8Array,
  required: readonly string[] = REQUIRED_TEMPLATE_FILES,
): string[] =>
  required.filter((name) => !encodings(name).some((needle) => contains(project, needle)));

/**
 * Whether a project's text is this track's: "current" when it carries
 * `marker`; "stale" when it carries another track's marker, so it would show
 * another track's title; "unmarked" when it carries none (a template built
 * by hand or by an older bootstrap, or a project that stores comments in a
 * way this byte search cannot see). Only "stale" is proof of a problem.
 */
export const templateTextStatus = (project: Uint8Array, marker: string): "current" | "stale" | "unmarked" => {
  if (missingTemplateFiles(project, [marker]).length === 0) return "current";
  if (missingTemplateFiles(project, [TEMPLATE_TEXT_MARKER_PREFIX]).length === 0) return "stale";
  return "unmarked";
};

/** What a finished render must contain; an empty list means it does. */
export const renderedMediaProblems = (streamTypes: readonly string[]): string[] => [
  ...(streamTypes.includes("video") ? [] : ["no video stream"]),
  ...(streamTypes.includes("audio") ? [] : ["no audio stream"]),
];

/**
 * Things worth saying about a template that are not worth refusing it for:
 * the composition name not found in the project's bytes (aerender reports a
 * missing composition itself, within seconds), or no Audio Waveform effect
 * (a template may simply not want one). Logged, never fatal, so an unusual
 * but valid project is never rejected.
 */
export const templateWarnings = (project: Uint8Array, composition: string): string[] => [
  ...(missingTemplateFiles(project, [composition]).length > 0
    ? [`composition "${composition}" was not found in the project file; aerender will stop if it really is missing.`]
    : []),
  ...(AUDIO_WAVEFORM_EFFECT_NAMES.every((name) => missingTemplateFiles(project, [name]).length > 0)
    ? [`the project has no Audio Waveform effect, so the video will have no waveform.`]
    : []),
];
