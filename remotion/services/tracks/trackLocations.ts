import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  LEGACY_OUTPUT_FILE_NAME,
  outputLabel,
  outputRelativePath,
  TRACKS_DIR_NAME,
  trackAssetPaths,
} from "../../src/domain/tracks/paths.ts";
import type { RenderPresetId } from "../../src/domain/video/renderPresets.ts";

/**
 * Resolves absolute filesystem paths from the public/-relative conventions in
 * the domain layer. Derived from this module's own location, so every caller
 * works regardless of the current working directory.
 */
const servicesTracksDir = path.dirname(fileURLToPath(import.meta.url));

export const PROJECT_ROOT = path.join(servicesTracksDir, "..", "..");
export const PUBLIC_DIR = path.join(PROJECT_ROOT, "public");
export const TRACKS_DIR = path.join(PUBLIC_DIR, TRACKS_DIR_NAME);
export const OUT_DIR = path.join(PROJECT_ROOT, "out");
export const REMOTION_ENTRY_POINT = path.join(PROJECT_ROOT, "src", "index.ts");

export type TrackLocations = {
  readonly trackDir: string;
  readonly cover: string;
  readonly beat: string;
  readonly analysis: string;
  readonly metadata: string;
  /** Directory holding this track's rendered formats. */
  readonly outputDir: string;
  /**
   * The pre-preset single-file output path. Read only, so an older render is
   * still discovered; nothing writes here.
   */
  readonly legacyOutput: string;
};

export const trackLocations = (slug: string): TrackLocations => {
  const relative = trackAssetPaths(slug);

  return {
    trackDir: path.join(TRACKS_DIR, slug),
    cover: path.join(PUBLIC_DIR, relative.cover),
    beat: path.join(PUBLIC_DIR, relative.beat),
    analysis: path.join(PUBLIC_DIR, relative.analysis),
    metadata: path.join(PUBLIC_DIR, relative.metadata),
    outputDir: path.join(OUT_DIR, slug),
    legacyOutput: path.join(OUT_DIR, LEGACY_OUTPUT_FILE_NAME(slug)),
  };
};

export type TrackOutputLocation = {
  readonly path: string;
  readonly dir: string;
  readonly label: string;
};

/** Absolute location of one track/format render. */
export const trackOutputLocation = (
  slug: string,
  presetId: RenderPresetId,
): TrackOutputLocation => ({
  path: path.join(OUT_DIR, outputRelativePath(slug, presetId)),
  dir: path.join(OUT_DIR, slug),
  label: outputLabel(slug, presetId),
});
