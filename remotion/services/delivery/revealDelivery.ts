import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { deliveryRelativePath } from "../../core/domain/delivery/deliveryPaths.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import {
  assertRenderPresetId,
} from "../../core/domain/video/renderPresets.ts";
import { assertDeliveryDestination } from "./deliveryDestination.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { readDeliverySettings, resolveDeliveryRoot } from "./deliverySettings.ts";

const run = promisify(execFile);

/**
 * Shows the export destination in Finder.
 *
 * No path is ever accepted from the caller: the root comes from stored
 * settings, the folder from the track's own metadata, and the filename from the
 * slug and preset. The result is asserted to be inside the configured root
 * before anything is revealed, and the command runs through execFile with an
 * argument array rather than a shell string.
 *
 * Reveals the nearest thing that exists — the file, else its folder, else the
 * root — so the action is useful before anything has been delivered instead of
 * failing.
 */
export const revealDeliveryDestination = async (
  slugInput?: string,
  presetInput?: unknown,
): Promise<{ readonly revealedPath: string }> => {
  const slug = slugInput === undefined ? undefined : assertValidSlug(slugInput);
  const presetId = slug === undefined ? undefined : assertRenderPresetId(presetInput);
  const { root, problem } = resolveDeliveryRoot(await readDeliverySettings());

  if (root === null) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        problem ??
          "No export destination is configured yet. Set one in Delivery settings first.",
      ),
    );
  }

  let target = root;

  if (slug !== undefined && presetId !== undefined) {
    const folder = (await inspectTrack(slug)).metadata?.deliveryFolder ?? null;
    const relative = deliveryRelativePath(slug, presetId, folder);
    const file = assertDeliveryDestination(root, relative);

    if (!file.startsWith(`${path.resolve(root)}${path.sep}`)) {
      throw new TrackError(
        trackIssue(
          "INVALID_REQUEST",
          `Refusing to reveal a path outside the export destination ${root}.`,
        ),
      );
    }

    target = existsSync(file) ? file : path.dirname(file);
    if (!existsSync(target)) target = root;
  }

  if (process.platform !== "darwin") {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        `Revealing a folder in Finder is only supported on macOS. The destination is ${target}.`,
      ),
    );
  }

  try {
    // -R reveals the item in its enclosing folder rather than opening it.
    await run("open", ["-R", target]);
  } catch (error) {
    throw new TrackError(
      trackIssue(
        "REVEAL_FAILED",
        `Could not reveal ${target}: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  return { revealedPath: target };
};
