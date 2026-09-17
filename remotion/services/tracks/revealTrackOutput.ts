import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { legacyOutputLabel } from "../../src/domain/tracks/paths.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import {
  assertRenderPresetId,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import { trackLocations, trackOutputLocation } from "./trackLocations.ts";

const run = promisify(execFile);

export type RevealTrackOutputResult = {
  readonly slug: string;
  readonly presetId: RenderPresetId | null;
  readonly outputPath: string;
  readonly outputLabel: string;
};

/**
 * Shows a track's rendered video in Finder.
 *
 * The path is never accepted from the caller: only a slug and a preset id are,
 * and the absolute path comes from trackOutputLocation() — so this can only
 * ever reveal one of this track's own renders and there is nothing to point at
 * anything else. The command runs through execFile with an argument array,
 * never a shell string, so the path cannot be interpreted as anything but a
 * path.
 *
 * macOS-only, which matches this project's scope.
 */
export const revealTrackOutput = async (
  slugInput: string,
  presetInput?: unknown,
): Promise<RevealTrackOutputResult> => {
  const slug = assertValidSlug(slugInput);
  const presetId = assertRenderPresetId(presetInput);

  const output = trackOutputLocation(slug, presetId);

  // Fall back to a render made before presets existed, so an older output is
  // still reachable rather than appearing to have vanished.
  const legacy = trackLocations(slug).legacyOutput;
  const target = existsSync(output.path)
    ? { path: output.path, label: output.label, presetId }
    : existsSync(legacy)
      ? { path: legacy, label: legacyOutputLabel(slug), presetId: null }
      : null;

  if (target === null) {
    throw new TrackError(
      trackIssue(
        "TRACK_NOT_FOUND",
        `Nothing rendered for "${slug}" in that format yet — ${output.label} does not exist.`,
        output.label,
      ),
    );
  }

  if (process.platform !== "darwin") {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        `Revealing a file in Finder is only supported on macOS. The video is at ${target.path}.`,
        target.label,
      ),
    );
  }

  try {
    // -R reveals the file in Finder rather than opening it in a player.
    await run("open", ["-R", target.path]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TrackError(
      trackIssue(
        "REVEAL_FAILED",
        `Could not reveal ${target.label}: ${reason}`,
        target.label,
      ),
    );
  }

  return {
    slug,
    presetId: target.presetId,
    outputPath: target.path,
    outputLabel: target.label,
  };
};
