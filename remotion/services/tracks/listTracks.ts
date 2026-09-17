import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import type { TrackInspection } from "../../src/domain/tracks/types.ts";
import { inspectTrack } from "./inspectTrack.ts";
import { TRACKS_DIR } from "./trackLocations.ts";

/** Every track folder under public/tracks/, inspected, sorted by slug. */
export const listTracks = async (): Promise<readonly TrackInspection[]> => {
  if (!existsSync(TRACKS_DIR)) {
    return [];
  }

  const entries = await readdir(TRACKS_DIR, { withFileTypes: true });
  const slugs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  return Promise.all(slugs.map(inspectTrack));
};

export const listTrackSlugs = async (): Promise<readonly string[]> => {
  const tracks = await listTracks();

  return tracks.map((track) => track.slug);
};
