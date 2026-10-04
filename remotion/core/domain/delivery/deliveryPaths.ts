import { TrackError, trackIssue } from "../tracks/errors.ts";
import { assertValidSlug } from "../tracks/slug.ts";
import {
  assertRenderPresetId,
  type RenderPresetId,
} from "../video/renderPresets.ts";

/**
 * Where a delivered copy goes inside a configured destination root.
 *
 * Pure and browser-safe: the layout lives here so the server, the CLI and the
 * UI all describe the same destination, and no folder naming is scattered
 * across call sites. Nothing here knows an absolute path — the machine-local
 * root is local configuration, deliberately kept out of portable data.
 *
 *   <root>/<track folder>/<slug>-<preset-id>.mp4
 *
 * The folder is human-chosen ("Ghetto Geek"), because that is the part someone
 * browsing a Movies or Dropbox folder reads. The filename stays canonical
 * kebab-case so a file still says what it is once it has been moved somewhere
 * else, and so nothing downstream has to quote it.
 */

export const DELIVERY_RECEIPT_VERSION = 2;
export const DELIVERY_SETTINGS_VERSION = 1;

/**
 * - not_configured: no destination root is set, so delivery is off
 * - pending:        never delivered
 * - delivered:      the copy matches the current canonical export
 * - outdated:       the copy no longer matches what should ship
 * - failed:         the last attempt in this response failed
 *
 * `failed` is only ever reported by a delivery attempt. Browsing re-derives
 * everything else from disk, so a stale "failed" can never be shown as if it
 * were still true.
 */
export type DeliveryStatus =
  | "not_configured"
  | "pending"
  | "delivered"
  | "outdated"
  | "failed";

/** Why a delivery is not current, or why an attempt could not run. */
export type DeliveryReason =
  | "never_delivered"
  | "export_changed"
  | "export_not_current"
  | "export_missing"
  | "destination_changed"
  | "destination_missing"
  | "destination_modified"
  | "source_changed"
  | "copy_failed"
  | "not_configured"
  /** The track prefers a renderer whose exports delivery does not handle. */
  | "renderer_not_supported";

export const DELIVERY_REASON_LABELS: Record<DeliveryReason, string> = {
  never_delivered: "Not delivered yet",
  export_changed: "Export re-rendered since delivery",
  export_not_current: "Export is not current",
  export_missing: "No export to deliver",
  destination_changed: "Destination changed",
  destination_missing: "Delivered file is missing",
  destination_modified: "Delivered file changed at the destination",
  source_changed: "Export changed while delivering",
  copy_failed: "Copy failed",
  not_configured: "No destination configured",
  renderer_not_supported: "Export renderer no longer matches the track",
};

/** How long a track's delivery folder name may be. */
const MAX_FOLDER_LENGTH = 80;

// Reserved on macOS/Windows or meaningful to a shell; rejected so a folder name
// can never be anything but one plain directory inside the root.
const UNSAFE_FOLDER = /[/\\:*?"<>|]/u;

const hasControlCharacter = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code < 0x20 || code === 0x7f;
  });

/**
 * Validates a track's delivery folder: exactly one ordinary directory name.
 *
 * This is the only user-authored text that reaches a destination path, so it is
 * checked to be a single segment with no separators and no traversal. Callers
 * still assert containment against the root afterwards.
 */
export const assertDeliveryFolder = (value: unknown): string => {
  const invalid = (why: string): never => {
    throw new TrackError(
      trackIssue(
        "METADATA_INVALID",
        `field "deliveryFolder" ${why} It is one folder name inside the export destination, e.g. "Ghetto Geek".`,
      ),
    );
  };

  if (typeof value !== "string") return invalid("must be a string.");

  const folder = value.trim();

  if (folder.length === 0) return invalid("must not be empty.");
  if (folder.length > MAX_FOLDER_LENGTH)
    return invalid(`must be at most ${MAX_FOLDER_LENGTH} characters.`);
  if (UNSAFE_FOLDER.test(folder))
    return invalid('must not contain / \\ : * ? " < > or |.');
  // "." and ".." are traversal; a leading dot would also hide the folder.
  if (folder.startsWith(".")) return invalid("must not start with a dot.");
  if (folder.endsWith(".")) return invalid("must not end with a dot.");
  if (hasControlCharacter(folder))
    return invalid("must not contain control characters.");

  return folder;
};

/** The folder a track delivers into: its own, or its slug. */
export const deliveryFolderFor = (
  slug: string,
  declared: string | null | undefined,
): string =>
  declared === null || declared === undefined || declared.trim() === ""
    ? assertValidSlug(slug)
    : assertDeliveryFolder(declared);

/** The delivered file's path relative to the destination root. */
export const deliveryRelativePath = (
  slug: string,
  presetId: RenderPresetId,
  declaredFolder?: string | null,
): string => {
  const validSlug = assertValidSlug(slug);
  const validPreset = assertRenderPresetId(presetId);

  return `${deliveryFolderFor(validSlug, declaredFolder)}/${validSlug}-${validPreset}.mp4`;
};
