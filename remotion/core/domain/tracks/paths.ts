import { DEFAULT_RENDERER_ID, type RendererId } from "../video/renderers.ts";

/**
 * The single source of truth for where a track's files live inside public/.
 *
 * Everything here is a plain string relative to public/, which is exactly
 * what staticFile() expects — so this module is safe to import from the
 * composition, from Node services, and from future UI code alike. Absolute
 * filesystem paths are a Node concern and live in services/tracks/trackLocations.
 */

export const TRACKS_DIR_NAME = "tracks";

export type TrackAssetPaths = {
  readonly cover: string;
  readonly beat: string;
  readonly analysis: string;
  readonly metadata: string;
};

export const trackAssetPaths = (slug: string): TrackAssetPaths => ({
  cover: `${TRACKS_DIR_NAME}/${slug}/cover.png`,
  beat: `${TRACKS_DIR_NAME}/${slug}/beat.wav`,
  analysis: `${TRACKS_DIR_NAME}/${slug}/analysis.wav`,
  metadata: `${TRACKS_DIR_NAME}/${slug}/metadata.json`,
});

export const BRAND_ASSET_PATHS = {
  logoLight: "brand/toshi/toshi-logo-light.png",
  iconMark: "brand/toshi/toshi-icon-mark.png",
} as const;

/**
 * The folder an engine's exports of one track live in, relative to out/.
 *
 * Remotion's exports stay exactly where they always were, directly in the
 * track's folder. Every other renderer gets a subfolder named after it, so two
 * engines' renders of the same format never overwrite each other and no
 * existing export has to move.
 */
export const outputFolderRelativePath = (slug: string, renderer: RendererId = DEFAULT_RENDERER_ID): string =>
  renderer === "remotion" ? slug : `${slug}/${renderer}`;

/**
 * Where a render lands, relative to out/.
 *
 * One folder per track, one file per format, so a track's exports sit together
 * and adding a format never collides with an existing file.
 */
export const outputRelativePath = (
  slug: string,
  presetId: string,
  renderer: RendererId = DEFAULT_RENDERER_ID,
): string => `${outputFolderRelativePath(slug, renderer)}/${presetId}.mp4`;

/** "out/<slug>/<preset>.mp4" (or "out/<slug>/<renderer>/<preset>.mp4"), for messages. */
export const outputLabel = (
  slug: string,
  presetId: string,
  renderer: RendererId = DEFAULT_RENDERER_ID,
): string => `out/${outputRelativePath(slug, presetId, renderer)}`;

/** The manifest beside an export, for messages and library records. */
export const manifestLabel = (
  slug: string,
  presetId: string,
  renderer: RendererId = DEFAULT_RENDERER_ID,
): string => `out/${outputFolderRelativePath(slug, renderer)}/${presetId}.manifest.json`;

/**
 * The single-file path renders used before presets existed.
 *
 * Still read, so a render produced by an earlier version is still found and
 * reported rather than silently disappearing from the UI. Nothing writes here
 * any more, and no existing file at this path is ever modified or removed.
 */
export const LEGACY_OUTPUT_FILE_NAME = (slug: string): string => `${slug}.mp4`;

export const legacyOutputLabel = (slug: string): string =>
  `out/${LEGACY_OUTPUT_FILE_NAME(slug)}`;

/** "tracks/x/cover.png" -> "public/tracks/x/cover.png", for messages. */
export const publicLabel = (publicRelativePath: string): string =>
  `public/${publicRelativePath}`;

/** "public/tracks/<slug>/", for messages. */
export const trackDirLabel = (slug: string): string =>
  `public/${TRACKS_DIR_NAME}/${slug}/`;
