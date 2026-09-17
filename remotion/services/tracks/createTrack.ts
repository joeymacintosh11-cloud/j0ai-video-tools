import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import {
  createDefaultMetadata,
  serializeTrackMetadata,
} from "../../src/domain/tracks/metadata.ts";
import { trackDirLabel } from "../../src/domain/tracks/paths.ts";
import { slugify } from "../../src/domain/tracks/slug.ts";
import type { TrackMetadataDraft } from "../../src/domain/tracks/types.ts";
import { trackLocations, type TrackLocations } from "./trackLocations.ts";

export type CreateTrackResult = {
  readonly slug: string;
  readonly metadata: TrackMetadataDraft;
  readonly locations: TrackLocations;
};

/**
 * Scaffolds public/tracks/<slug>/ with a metadata.json template.
 *
 * Never overwrites: an existing track folder is refused up front, and the
 * metadata write itself uses the "wx" flag so a race can't clobber a file
 * either. Nothing else in the folder is created or touched — the cover and
 * beat are the caller's to add.
 */
export const createTrack = async (
  title: string,
): Promise<CreateTrackResult> => {
  const trimmedTitle = title.trim();

  if (trimmedTitle.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_TRACK_NAME", "A track name is required."),
    );
  }

  const slug = slugify(trimmedTitle);

  if (slug.length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_TRACK_NAME",
        `Could not derive a folder name from "${trimmedTitle}". Use at least one letter or number.`,
      ),
    );
  }

  const locations = trackLocations(slug);

  if (existsSync(locations.trackDir)) {
    throw new TrackError(
      trackIssue(
        "TRACK_ALREADY_EXISTS",
        `Track "${slug}" already exists at ${trackDirLabel(slug)}. ` +
          `Refusing to overwrite it — pick a different name, or edit that folder directly.`,
        trackDirLabel(slug),
      ),
    );
  }

  const metadata = createDefaultMetadata(trimmedTitle);

  await mkdir(locations.trackDir, { recursive: true });
  await writeFile(locations.metadata, serializeTrackMetadata(metadata), {
    flag: "wx",
  });

  return { slug, metadata, locations };
};
