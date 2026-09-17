import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OUTPUT_FILE_NAME,
  TRACKS_DIR_NAME,
  trackAssetPaths,
} from "../../src/domain/tracks/paths.ts";

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
  readonly output: string;
};

export const trackLocations = (slug: string): TrackLocations => {
  const relative = trackAssetPaths(slug);

  return {
    trackDir: path.join(TRACKS_DIR, slug),
    cover: path.join(PUBLIC_DIR, relative.cover),
    beat: path.join(PUBLIC_DIR, relative.beat),
    analysis: path.join(PUBLIC_DIR, relative.analysis),
    metadata: path.join(PUBLIC_DIR, relative.metadata),
    output: path.join(OUT_DIR, OUTPUT_FILE_NAME(slug)),
  };
};
