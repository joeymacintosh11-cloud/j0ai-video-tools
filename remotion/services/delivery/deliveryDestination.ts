import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";

/**
 * Identifies and fences a delivery destination.
 *
 * Errors are structured so the API reports them as a request problem rather
 * than an internal fault: a destination that moved or was replaced is something
 * the user can act on.
 */

const refuse = (message: string): never => {
  throw new TrackError(trackIssue("INVALID_REQUEST", message));
};

/** dev:ino of a directory, so a pathname swap is detectable. */
export const directoryIdentity = (directory: string): string => {
  const stat = statSync(directory);
  if (!stat.isDirectory()) refuse(`"${directory}" is not a folder.`);
  return `${stat.dev}:${stat.ino}`;
};

/**
 * The absolute path of one bookkeeping file at the destination root itself.
 *
 * The delivery log lives at the root rather than inside a track folder, because
 * it is a record of the destination as a whole. It still goes through the same
 * fencing a delivered video does: a single plain filename, no separators, no
 * traversal, and a root that is still the resolved directory it was configured
 * as.
 */
export const assertDeliveryRootFile = (
  root: string,
  filename: string,
): string => {
  if (
    filename.length === 0 ||
    filename !== path.basename(filename) ||
    filename === "." ||
    filename === ".."
  ) {
    refuse(`Refusing "${filename}" as a file name at the export destination.`);
  }

  // The stored root is resolved, so anything else means it moved or was
  // replaced since it was configured.
  if (realpathSync(root) !== root) {
    refuse(`The export destination ${root} changed.`);
  }

  const file = path.resolve(root, filename);

  if (path.dirname(file) !== root) {
    refuse(`Refusing a path outside the export destination ${root}.`);
  }

  // A bookkeeping file that is a symlink would have every write to it land
  // wherever it points — outside the destination, and possibly on top of
  // something that matters. The delivered-video path is fenced the same way
  // (its parent must be a real directory), and appends additionally pass
  // O_NOFOLLOW so nothing can be swapped in after this check.
  try {
    const stat = lstatSync(file);
    if (!stat.isFile()) {
      refuse(
        `${file} must be a regular file, not a link or a directory. Move it aside before continuing.`,
      );
    }
  } catch (error) {
    if (error instanceof TrackError) throw error;
    // Not created yet is fine; the caller creates it inside the root.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return file;
};

/**
 * The absolute destination for one delivered file, constrained to the root.
 *
 * Used for reads, reveals and status. Copying additionally pins its working
 * directory in a short-lived helper, so a swapped pathname cannot redirect a
 * write even between this check and the copy.
 */
export const assertDeliveryDestination = (
  root: string,
  relative: string,
): string => {
  const segments = relative.split("/");
  const file = path.resolve(root, relative);
  const parent = path.dirname(file);

  if (
    segments.length !== 2 ||
    path.dirname(parent) !== root ||
    path.basename(file) !== segments[1]
  ) {
    refuse(`Refusing a delivery path outside the export destination ${root}.`);
  }

  // The stored root is resolved, so anything else means it moved or was
  // replaced since it was configured.
  if (realpathSync(root) !== root) {
    refuse(`The export destination ${root} changed.`);
  }

  try {
    const stat = lstatSync(parent);
    if (!stat.isDirectory() || realpathSync(parent) !== parent) {
      refuse(
        `The delivery folder ${parent} must be a real directory, not a link.`,
      );
    }
  } catch (error) {
    if (error instanceof TrackError) throw error;
    // Not created yet is fine; the copy helper creates it inside the root.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  return file;
};
