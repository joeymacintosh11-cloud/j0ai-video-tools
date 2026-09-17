import { TrackError, trackIssue } from "./errors.ts";

/**
 * Turns a human-readable track name into a URL/folder-safe slug.
 * "Midnight Rider" -> "midnight-rider"
 */
export const slugify = (input: string): string =>
  input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

/**
 * Exactly the shape slugify() produces. Anything else is rejected, which is
 * also what keeps a slug from ever escaping public/tracks/ — no dots, no
 * slashes, no absolute paths, no "..".
 */
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const isValidSlug = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 100 &&
  SLUG_PATTERN.test(value);

/** Guards any slug arriving from outside the process (HTTP, argv). */
export const assertValidSlug = (value: unknown): string => {
  if (!isValidSlug(value)) {
    throw new TrackError(
      trackIssue(
        "INVALID_SLUG",
        `"${String(value)}" is not a valid track slug. Use lowercase letters, ` +
          `numbers and single hyphens, e.g. "midnight-rider".`,
      ),
    );
  }

  return value;
};
