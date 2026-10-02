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
 * A template imports those files once, by these names, as footage. After
 * Effects reloads them from disk every time aerender opens the project, so
 * one template renders any track. Text comes from the JSON through
 * expressions (TEMPLATE_EXPRESSIONS); images and audio come from the staged
 * files, because an expression cannot change which file a footage item uses.
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
 * What a template must use, or its render cannot show the track: the data
 * (text), the cover and the audio. A template that references none of them
 * renders a black, silent video, which is what this check exists to stop.
 */
export const REQUIRED_TEMPLATE_FILES = [
  TEMPLATE_DATA_FILE_NAME,
  `${STAGED_ASSET_NAMES.cover}.png`,
  `${STAGED_ASSET_NAMES.audio}.wav`,
] as const;

/**
 * The expressions a template's text layers use, keyed by the layer names the
 * bootstrap script (template/create-toshi-template.jsx) creates. Each reads
 * a field of TemplateData; tests check every path exists, so renaming a
 * field cannot silently blank a template.
 */
export const TEMPLATE_EXPRESSIONS = {
  Title: `footage("${TEMPLATE_DATA_FILE_NAME}").sourceData.track.title`,
  Artist: `footage("${TEMPLATE_DATA_FILE_NAME}").sourceData.track.artist`,
  "Key BPM": `var t = footage("${TEMPLATE_DATA_FILE_NAME}").sourceData.track; t.key + "  \\u00b7  " + t.bpm + " BPM"`,
} as const;

/** The TemplateData fields TEMPLATE_EXPRESSIONS read, as paths. */
export const TEMPLATE_DATA_FIELDS_READ = [
  ["track", "title"],
  ["track", "artist"],
  ["track", "key"],
  ["track", "bpm"],
] as const;

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

/** What a finished render must contain; an empty list means it does. */
export const renderedMediaProblems = (streamTypes: readonly string[]): string[] => [
  ...(streamTypes.includes("video") ? [] : ["no video stream"]),
  ...(streamTypes.includes("audio") ? [] : ["no audio stream"]),
];
