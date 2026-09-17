import { existsSync } from "node:fs";
import { readFile, rename, unlink, writeFile } from "node:fs/promises";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import {
  serializeTrackMetadata,
  validateTrackMetadata,
} from "../../src/domain/tracks/metadata.ts";
import {
  publicLabel,
  trackAssetPaths,
} from "../../src/domain/tracks/paths.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import type {
  TrackMetadata,
  TrackMetadataDraft,
} from "../../src/domain/tracks/types.ts";
import { trackLocations } from "./trackLocations.ts";

/** Every field a caller is allowed to change. The slug is never one of them. */
export type TrackMetadataPatch = {
  readonly title?: string;
  readonly artist?: string;
  readonly key?: string;
  readonly bpm?: number | null;
  readonly subtitle?: string;
};

export type UpdateTrackMetadataResult = {
  readonly slug: string;
  readonly metadata: TrackMetadata;
};

const readExistingDraft = async (
  slug: string,
): Promise<TrackMetadataDraft> => {
  const locations = trackLocations(slug);
  const source = publicLabel(trackAssetPaths(slug).metadata);

  if (!existsSync(locations.metadata)) {
    throw new TrackError(
      trackIssue(
        "METADATA_MISSING",
        `Track "${slug}" is missing metadata: ${source}`,
        source,
      ),
    );
  }

  const raw = await readFile(locations.metadata, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TrackError(
      trackIssue(
        "METADATA_INVALID",
        `${source} is not valid JSON: ${reason}`,
        source,
      ),
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TrackError(
      trackIssue(
        "METADATA_INVALID",
        `${source} must contain a JSON object.`,
        source,
      ),
    );
  }

  const current = parsed as Record<string, unknown>;

  return {
    title: typeof current.title === "string" ? current.title : "",
    artist: typeof current.artist === "string" ? current.artist : "",
    key: typeof current.key === "string" ? current.key : "",
    bpm: typeof current.bpm === "number" ? current.bpm : null,
    subtitle:
      typeof current.subtitle === "string" ? current.subtitle : undefined,
  };
};

/**
 * Merges a patch into a track's metadata.json.
 *
 * Validates the merged result *before* writing, so an invalid patch can never
 * leave a corrupt file behind. The write itself goes to a temp file and is
 * renamed into place, which is atomic on the same filesystem — a reader either
 * sees the old file or the new one, never a half-written one.
 *
 * The slug (and therefore the folder name) is never changed by a title edit.
 */
export const updateTrackMetadata = async (
  slugInput: string,
  patch: TrackMetadataPatch,
): Promise<UpdateTrackMetadataResult> => {
  const slug = assertValidSlug(slugInput);
  const locations = trackLocations(slug);
  const source = publicLabel(trackAssetPaths(slug).metadata);

  const current = await readExistingDraft(slug);

  const merged: TrackMetadataDraft = {
    title: patch.title ?? current.title,
    artist: patch.artist ?? current.artist,
    key: patch.key ?? current.key,
    bpm: patch.bpm === undefined ? current.bpm : patch.bpm,
    subtitle: patch.subtitle ?? current.subtitle,
  };

  const { issues, metadata } = validateTrackMetadata(merged, source);

  if (metadata === null) {
    throw new TrackError(
      issues[0] ??
        trackIssue("METADATA_INVALID", `${source} is not valid.`, source),
    );
  }

  const tempPath = `${locations.metadata}.tmp-${process.pid}`;

  try {
    await writeFile(tempPath, serializeTrackMetadata(metadata), "utf-8");
    await rename(tempPath, locations.metadata);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new TrackError(
      trackIssue(
        "METADATA_WRITE_FAILED",
        `Could not write ${source}: ${reason}`,
        source,
      ),
    );
  }

  return { slug, metadata };
};
