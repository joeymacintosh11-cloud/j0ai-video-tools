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
 * How every text expression reads the template data, whatever shape After
 * Effects hands it over in.
 *
 * `footage(...).sourceData` is documented as returning a JSON file's data "as
 * an array of sourceData objects", and versions differ on whether a top-level
 * object arrives as itself or wrapped in an array. A plain
 * `sourceData.track.title` then throws, After Effects disables the expression
 * and the layer silently shows its placeholder text. So the loader accepts
 * either shape, falls back to parsing the file's text (`sourceText`) itself,
 * and works on both the JavaScript and the legacy ExtendScript expression
 * engines (no JSON object there, hence eval).
 */
export const TEMPLATE_DATA_LOADER = [
  `var TOSHI_DATA = "${TEMPLATE_DATA_FILE_NAME}";`,
  `function toshiTrack() {`,
  `  var data = null;`,
  `  try { data = footage(TOSHI_DATA).sourceData; } catch (err) { data = null; }`,
  `  if (data && !data.track && data.length > 0) { data = data[0]; }`,
  `  if (!data || !data.track) {`,
  `    var text = footage(TOSHI_DATA).sourceText;`,
  `    data = typeof JSON !== "undefined" ? JSON.parse(text) : eval("(" + text + ")");`,
  `  }`,
  `  return data.track;`,
  `}`,
].join("\n");

/**
 * A text expression: the loader, then `body`. If the data cannot be read at
 * all, the layer shows "[toshi-render-data.json: <reason>]" instead of
 * silently keeping its placeholder, so a broken template is obvious in the
 * very first frame.
 */
export const templateTextExpression = (body: string): string =>
  `${TEMPLATE_DATA_LOADER}\ntry {\n  ${body}\n} catch (err) {\n  "[" + TOSHI_DATA + ": " + err.message + "]";\n}`;

/**
 * The text layers' expressions, keyed by the layer names the bootstrap script
 * (template/create-toshi-template.jsx) creates. Optional fields left out of
 * the data render as nothing rather than "undefined".
 */
export const TEMPLATE_EXPRESSIONS = {
  Title: templateTextExpression(`var t = toshiTrack(); t.title ? String(t.title) : "";`),
  Artist: templateTextExpression(`var t = toshiTrack(); t.artist ? String(t.artist) : "";`),
  "Key BPM": templateTextExpression(
    `var t = toshiTrack(); var parts = []; if (t.key) { parts.push(String(t.key)); } if (t.bpm) { parts.push(t.bpm + " BPM"); } parts.join(" \\u00b7 ");`,
  ),
} as const;

/** The TemplateData fields TEMPLATE_EXPRESSIONS read, as paths. */
export const TEMPLATE_DATA_FIELDS_READ = [
  ["track", "title"],
  ["track", "artist"],
  ["track", "key"],
  ["track", "bpm"],
] as const;

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
