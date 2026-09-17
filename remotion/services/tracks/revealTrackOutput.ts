import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { OUTPUT_FILE_NAME } from "../../src/domain/tracks/paths.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import { trackLocations } from "./trackLocations.ts";

const run = promisify(execFile);

export type RevealTrackOutputResult = {
  readonly slug: string;
  readonly outputPath: string;
  readonly outputLabel: string;
};

/**
 * Shows a track's rendered video in Finder.
 *
 * The path is never accepted from the caller: only a slug is, and the absolute
 * path comes from trackLocations(slug) — so this can only ever reveal
 * out/<slug>.mp4 and there is nothing to point at anything else. The command
 * runs through execFile with an argument array, never a shell string, so the
 * path cannot be interpreted as anything but a path.
 *
 * macOS-only, which matches this project's scope.
 */
export const revealTrackOutput = async (
  slugInput: string,
): Promise<RevealTrackOutputResult> => {
  const slug = assertValidSlug(slugInput);
  const outputPath = trackLocations(slug).output;
  const outputLabel = `out/${OUTPUT_FILE_NAME(slug)}`;

  if (!existsSync(outputPath)) {
    throw new TrackError(
      trackIssue(
        "TRACK_NOT_FOUND",
        `Nothing rendered for "${slug}" yet — ${outputLabel} does not exist.`,
        outputLabel,
      ),
    );
  }

  if (process.platform !== "darwin") {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        `Revealing a file in Finder is only supported on macOS. The video is at ${outputPath}.`,
        outputLabel,
      ),
    );
  }

  try {
    // -R reveals the file in Finder rather than opening it in a player.
    await run("open", ["-R", outputPath]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TrackError(
      trackIssue(
        "REVEAL_FAILED",
        `Could not reveal ${outputLabel}: ${reason}`,
        outputLabel,
      ),
    );
  }

  return { slug, outputPath, outputLabel };
};
