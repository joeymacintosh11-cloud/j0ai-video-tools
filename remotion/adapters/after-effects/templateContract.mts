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
 * object arrives as itself or wrapped in an array. So the loader accepts
 * either shape, falls back to parsing the file's text (`sourceText`) itself,
 * and works on both the JavaScript and the legacy ExtendScript expression
 * engines (no JSON object there, hence eval).
 *
 * TEMPORARY DIAGNOSTICS: while the real After Effects data shape is being
 * pinned down, the loader records each access step it reaches and what it
 * found there (toshiStep, toshiInfo), so a failure can say exactly where and
 * why (see templateTextExpression). `footage()` is called once, at the top
 * level of the expression rather than inside a function.
 */
export const TEMPLATE_DATA_LOADER = [
  `var TOSHI_DATA = "${TEMPLATE_DATA_FILE_NAME}";`,
  `var toshiStep = "footage";`,
  `var toshiInfo = { foot: "-", sd: "-", txt: "-", track: "-" };`,
  `var toshiItem = null;`,
  `var toshiFootageError = null;`,
  `try { toshiItem = footage(TOSHI_DATA); } catch (err) { toshiFootageError = err; }`,
  `function toshiKind(v) {`,
  `  if (v === null) { return "null"; }`,
  `  if (v === undefined) { return "undef"; }`,
  `  if (typeof v === "string") { return "str" + v.length; }`,
  `  if (typeof v !== "object") { return typeof v; }`,
  `  if (Object.prototype.toString.call(v) === "[object Array]") { return "arr" + v.length; }`,
  `  var keys = [];`,
  `  try { for (var k in v) { if (keys.length < 3) { keys.push(String(k).substring(0, 10)); } } } catch (err) {}`,
  `  return (typeof v.length === "number" ? "list" + v.length : "obj") + "{" + keys.join(",") + "}";`,
  `}`,
  `function toshiTrack() {`,
  `  toshiStep = "footage";`,
  `  toshiInfo.foot = toshiFootageError ? "err" : toshiItem === null ? "null" : toshiItem === undefined ? "undef" : "ok";`,
  `  if (toshiFootageError) { throw toshiFootageError; }`,
  `  toshiStep = "sourceData";`,
  `  var data = null;`,
  `  try { data = toshiItem.sourceData; toshiInfo.sd = toshiKind(data); } catch (err) { data = null; toshiInfo.sd = "err"; }`,
  `  toshiStep = "unwrap";`,
  `  if (data && !data.track && data.length > 0) { data = data[0]; }`,
  `  if (!data || !data.track) {`,
  `    toshiStep = "sourceText";`,
  `    var text = toshiItem.sourceText;`,
  `    toshiInfo.txt = toshiKind(text);`,
  `    toshiStep = "parse";`,
  `    data = typeof JSON !== "undefined" ? JSON.parse(text) : eval("(" + text + ")");`,
  `  }`,
  `  toshiStep = "track";`,
  `  var track = data.track;`,
  `  toshiInfo.track = track ? "yes" : "no";`,
  `  if (!track) { throw new Error("data.track is " + toshiKind(track)); }`,
  `  toshiStep = "field";`,
  `  return track;`,
  `}`,
  `function toshiReport(err) {`,
  `  var message = err && err.message !== undefined ? String(err.message) : String(err);`,
  `  return "[data " + toshiStep + "] foot:" + toshiInfo.foot + " sd:" + toshiInfo.sd + " txt:" + toshiInfo.txt +`,
  `    " track:" + toshiInfo.track + "\\r" + message.substring(0, 80);`,
  `}`,
].join("\n");

/** The font size a failure's diagnostic is drawn at, so both of its lines fit in the frame. */
export const TEMPLATE_DIAGNOSTIC_FONT_SIZE = 20;

/**
 * A text expression: the loader, then `body`. If the data cannot be read, the
 * layer shows a two-line diagnostic instead of its placeholder:
 *
 *   [data <step>] foot:<ok|null|undef|err> sd:<kind> txt:<kind> track:<yes|no|->
 *   <the caught error's message, at most 80 characters>
 *
 * where <step> is the access step that failed (footage, sourceData, unwrap,
 * sourceText, parse, track, field) and a <kind> is null, undef, strN (a
 * string of N characters), arrN (an array of N), listN{keys} (array-like),
 * obj{keys} (the first three keys) or "-" (not reached). It is drawn at
 * TEMPLATE_DIAGNOSTIC_FONT_SIZE through the text style API where After Effects
 * has it (the JavaScript engine), and as plain text otherwise.
 */
export const templateTextExpression = (body: string): string =>
  `${TEMPLATE_DATA_LOADER}\ntry {\n  ${body}\n} catch (err) {\n  var toshiMessage = toshiReport(err);\n` +
  `  try { text.sourceText.style.setFontSize(${TEMPLATE_DIAGNOSTIC_FONT_SIZE}).setText(toshiMessage); } catch (styleErr) { toshiMessage; }\n}`;

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
