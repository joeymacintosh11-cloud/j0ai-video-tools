import { TrackError, trackIssue } from "../tracks/errors.ts";

/**
 * The export formats the visualizer can render, defined once.
 *
 * Pure and dependency-free, so the composition, the render service, the API,
 * the CLI and the UI all read the same numbers instead of repeating them. A new
 * format is added here and everywhere else picks it up.
 *
 * `layout` is the only thing the composition branches on. It is deliberately a
 * small set of shapes rather than one per preset, so two presets with the same
 * proportions share a layout instead of growing a second implementation.
 */

export type RenderLayout = "landscape" | "portrait" | "square";

export const RENDER_PRESET_IDS = [
  "youtube-16x9",
  "vertical-9x16",
  "square-1x1",
] as const;

export type RenderPresetId = (typeof RENDER_PRESET_IDS)[number];

export type RenderPreset = {
  readonly id: RenderPresetId;
  readonly label: string;
  /** Short form for compact UI, e.g. a checkbox row. */
  readonly shortLabel: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly aspectRatio: string;
  readonly layout: RenderLayout;
};

export const RENDER_PRESETS: Record<RenderPresetId, RenderPreset> = {
  "youtube-16x9": {
    id: "youtube-16x9",
    label: "YouTube Landscape",
    shortLabel: "YouTube 16:9",
    width: 1920,
    height: 1080,
    fps: 30,
    aspectRatio: "16:9",
    layout: "landscape",
  },
  "vertical-9x16": {
    id: "vertical-9x16",
    label: "Reels / Shorts",
    shortLabel: "Reels 9:16",
    width: 1080,
    height: 1920,
    fps: 30,
    aspectRatio: "9:16",
    layout: "portrait",
  },
  "square-1x1": {
    id: "square-1x1",
    label: "Square",
    shortLabel: "Square 1:1",
    width: 1080,
    height: 1080,
    fps: 30,
    aspectRatio: "1:1",
    layout: "square",
  },
};

/**
 * The format everything defaults to when none is named.
 *
 * This is what `render-track` produced before presets existed, so leaving it
 * unspecified keeps the original behaviour.
 */
export const DEFAULT_RENDER_PRESET_ID: RenderPresetId = "youtube-16x9";

export const RENDER_PRESET_LIST: readonly RenderPreset[] =
  RENDER_PRESET_IDS.map((id) => RENDER_PRESETS[id]);

export const isRenderPresetId = (value: unknown): value is RenderPresetId =>
  typeof value === "string" &&
  (RENDER_PRESET_IDS as readonly string[]).includes(value);

export const renderPreset = (id: RenderPresetId): RenderPreset =>
  RENDER_PRESETS[id];

/** Resolves a preset id from untrusted input, defaulting when absent. */
export const assertRenderPresetId = (value: unknown): RenderPresetId => {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_RENDER_PRESET_ID;
  }

  if (!isRenderPresetId(value)) {
    throw new TrackError(
      trackIssue(
        "INVALID_PRESET",
        `Unknown render preset ${JSON.stringify(value)}. Expected one of: ${RENDER_PRESET_IDS.join(", ")}.`,
      ),
    );
  }

  return value;
};

/* ------------------------------------------------------------------ *
 * Declared export intent
 * ------------------------------------------------------------------ */

/**
 * A track's `exportPresets` — which formats it is meant to ship in.
 *
 * The helpers below are the only place that knowledge lives. Metadata
 * validation, the API, the planner, the CLI and the UI all go through them, so
 * a new format needs no second list and no string union anywhere else.
 */

/** Canonical order, duplicates dropped. */
export const canonicalPresetOrder = (
  ids: Iterable<RenderPresetId>,
): readonly RenderPresetId[] => {
  const wanted = new Set(ids);

  return RENDER_PRESET_IDS.filter((id) => wanted.has(id));
};

/**
 * Strict read of a declared `exportPresets` list.
 *
 * Collects every problem rather than throwing at the first, so a metadata file
 * with two bad entries reports both. Messages are written to be prefixed with
 * the file they came from. `presets` is non-null only when there are none.
 */
export const parseExportPresetList = (
  raw: unknown,
): {
  readonly presets: readonly RenderPresetId[] | null;
  readonly problems: readonly string[];
} => {
  const expected = `Expected ids: ${RENDER_PRESET_IDS.join(", ")}.`;

  if (!Array.isArray(raw)) {
    return {
      presets: null,
      problems: [
        `field "exportPresets" must be an array of format ids when present. ${expected}`,
      ],
    };
  }

  const problems: string[] = [];
  const seen = new Set<RenderPresetId>();

  // An empty list would mean "ship nowhere", which is far more likely to be a
  // mistake than an intention. Leaving the field out is how you say
  // "undeclared", and that is what an empty list is steered towards.
  if (raw.length === 0) {
    problems.push(
      `field "exportPresets" must name at least one format, or be left out entirely to mean every format.`,
    );
  }

  for (const value of raw) {
    if (!isRenderPresetId(value)) {
      problems.push(
        `field "exportPresets" contains unknown format ${JSON.stringify(value)}. ${expected}`,
      );
      continue;
    }

    if (seen.has(value)) {
      problems.push(
        `field "exportPresets" lists ${JSON.stringify(value)} more than once.`,
      );
      continue;
    }

    seen.add(value);
  }

  return problems.length > 0
    ? { presets: null, problems }
    : { presets: canonicalPresetOrder(seen), problems };
};

/**
 * Best-effort read, for prefilling an editor from a file that may not be valid.
 *
 * Unusable entries are dropped rather than reported — the strict parse above is
 * what decides whether the file is acceptable. Undefined means "nothing usable
 * was declared", which callers read as undeclared.
 */
export const coerceExportPresetList = (
  raw: unknown,
): readonly RenderPresetId[] | undefined => {
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const usable = canonicalPresetOrder(raw.filter(isRenderPresetId));

  return usable.length > 0 ? usable : undefined;
};

/**
 * The formats a track should be exported in.
 *
 * An undeclared track resolves to every supported format, which is exactly what
 * "export what's missing" meant before intent existed — so tracks written
 * before this field arrived keep behaving as they always did, and nothing has
 * to be migrated. Declaring the field is what narrows it.
 */
export const resolveExportPresets = (
  declared: readonly RenderPresetId[] | null | undefined,
): readonly RenderPresetId[] =>
  declared && declared.length > 0
    ? canonicalPresetOrder(declared)
    : RENDER_PRESET_IDS;
