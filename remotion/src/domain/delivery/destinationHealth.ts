import { formatBytes, formatBundleTimestamp } from "./releaseBundle.ts";
import {
  RELEASE_JSON_FILENAME,
  RELEASE_MARKDOWN_FILENAME,
} from "./releaseBundle.ts";
import {
  DELIVERY_LOG_FILENAME,
  DELIVERY_REPORT_FILENAME,
} from "./deliveryHistory.ts";
import type { RenderPresetId } from "../video/renderPresets.ts";

/**
 * Compares what the destination should hold against what is actually there.
 *
 * A release bundle describes a track's own current state; the delivery log
 * describes history. Neither one ever looks at the destination's *other*
 * contents — an MP4 sitting there has never been trusted as proof of
 * anything, and nothing before this scanned the destination folder itself for
 * files or folders the rest of the app does not know about.
 *
 * This module is the pure half: the finding shape, severities, the filename
 * rules that decide what counts as "ours" versus "not our business", and the
 * messages. All of it is browser-safe, so the server, the CLI and the UI agree
 * on what a finding means without repeating the policy in three places. The
 * scan itself — every `readdir` and `stat` — lives in the service layer,
 * because a health scan is inescapably about what is on disk right now.
 */

/**
 * - not_configured: no destination, so there is nothing to scan
 * - healthy:        the destination was scanned and nothing was found
 * - drift:          the destination was scanned and at least one finding came
 *                    back, of any severity
 * - unavailable:    the configured destination cannot be reached at all —
 *                    exactly what delivery and release bundles already call
 *                    `rootProblem`
 * - error:          the scan itself could not complete as intended, distinct
 *                    from finding drift while scanning cleanly
 */
export type DestinationHealthStatus =
  | "not_configured"
  | "healthy"
  | "drift"
  | "unavailable"
  | "error";

export type DestinationFindingSeverity = "info" | "warning" | "error";

/**
 * What a finding is a report of.
 *
 * Two of the codes the original brief for this feature suggested —
 * `receipt_without_file` and `file_without_matching_receipt` — are
 * deliberately not separate codes here. They are exactly `delivered_file_missing`
 * and `unexpected_export_file` under a second name: "a receipt names a file
 * that is not there" *is* a missing delivered file, and "a file exists with no
 * receipt behind it" *is* an unexpected export. Two names for one fact would
 * only make call sites guess which one to check.
 */
export type DestinationFindingCode =
  /** The configured root's own identity no longer matches what was configured — it, or a parent segment, has become a symlink to somewhere else since. */
  | "destination_root_identity_changed"
  /** A folder that should be listable (the root, or a track's own folder) could not be read — a permissions problem, typically, not a missing folder. */
  | "destination_folder_unreadable"
  /** A track has at least one delivery receipt, but its entire destination folder is gone. */
  | "track_folder_missing"
  /** A receipt says a file was delivered; it is not there any more. */
  | "delivered_file_missing"
  /** A receipt says a file was delivered; what is there now does not match what was recorded. */
  | "delivered_file_changed"
  /** A file a receipt names exists but could not be examined (a permissions problem, or it is not a plain file). */
  | "destination_file_unreadable"
  /** A file inside a track's folder looks like one of this app's own exports, but no current receipt accounts for it. */
  | "unexpected_export_file"
  /** A folder at the destination root looks app-managed, but no active track's delivery folder resolves to it. */
  | "unexpected_track_folder"
  /** Something has been delivered, but the track has never had a release bundle written. */
  | "release_bundle_missing"
  /** A release bundle exists but no longer matches current delivery state. */
  | "release_bundle_outdated"
  /** A release bundle's two files (release.json and release.md) disagree with each other, not merely with current state. */
  | "release_bundle_pair_mismatch";

/**
 * Fixed and deterministic, per the brief: a finding's severity is a function
 * of its code alone, never a judgment call made at the point it is raised.
 *
 * `error` for anything that means "content the destination should hold cannot
 * currently be found or trusted at all". `warning` for content that is present
 * but wrong, or bookkeeping that has fallen behind. `info` for a discovery
 * that is worth a look but implies nothing is actually broken — an orphaned
 * folder from a renamed track, or a bundle simply never having been generated.
 */
export const DESTINATION_FINDING_SEVERITY: Record<
  DestinationFindingCode,
  DestinationFindingSeverity
> = {
  destination_root_identity_changed: "error",
  destination_folder_unreadable: "error",
  track_folder_missing: "error",
  delivered_file_missing: "error",
  delivered_file_changed: "warning",
  destination_file_unreadable: "error",
  unexpected_export_file: "warning",
  unexpected_track_folder: "info",
  release_bundle_missing: "info",
  release_bundle_outdated: "warning",
  release_bundle_pair_mismatch: "warning",
};

export type DestinationFinding = {
  readonly code: DestinationFindingCode;
  readonly severity: DestinationFindingSeverity;
  readonly message: string;
  /** The track this concerns, or null for a root-level or orphaned-folder finding. */
  readonly slug: string | null;
  readonly presetId: RenderPresetId | null;
  /** Path relative to the destination root, when the finding names one. */
  readonly relativePath: string | null;
};

/** Builds one finding, filling in the severity from the code. */
export const destinationFinding = (
  code: DestinationFindingCode,
  message: string,
  extra: {
    readonly slug?: string | null;
    readonly presetId?: RenderPresetId | null;
    readonly relativePath?: string | null;
  } = {},
): DestinationFinding => ({
  code,
  severity: DESTINATION_FINDING_SEVERITY[code],
  message,
  slug: extra.slug ?? null,
  presetId: extra.presetId ?? null,
  relativePath: extra.relativePath ?? null,
});

/* ------------------------------------------------------------------ *
 * What counts as "ours" — the one place this is decided
 * ------------------------------------------------------------------ */

/** Dotfiles: our own transient lock, and anything a filesystem or OS drops. Never drift. */
export const isIgnorableFilename = (filename: string): boolean =>
  filename.startsWith(".");

/** The two files a release bundle writes inside a track's own folder. */
export const isTrackBookkeepingFilename = (filename: string): boolean =>
  filename === RELEASE_JSON_FILENAME || filename === RELEASE_MARKDOWN_FILENAME;

/** The files this app writes at the destination root itself. */
export const isDestinationRootBookkeepingFilename = (filename: string): boolean =>
  filename === DELIVERY_LOG_FILENAME || filename === DELIVERY_REPORT_FILENAME;

/**
 * The exact filename a delivery would use for one track and format.
 *
 * Matches `deliveryRelativePath()` in `deliveryPaths.ts` exactly — this is not
 * a second naming scheme, it is the same one, read back for comparison rather
 * than written.
 */
export const managedExportFilename = (
  slug: string,
  presetId: string,
): string => `${slug}-${presetId}.mp4`;

/**
 * Whether a filename follows this app's own naming convention for *some*
 * export of this track — any preset id, including one that has since been
 * retired, which is exactly the "export from a retired preset" case the file
 * convention has to survive.
 *
 * Deliberately narrow: a file that does not begin with `<slug>-` is left alone
 * completely, however export-like it looks, because it is clearly not this
 * app's own naming. A stray "trailer.mp4" or a home movie a person dropped
 * into the folder is not this scanner's business.
 */
export const looksLikeManagedExportFile = (
  filename: string,
  slug: string,
): boolean =>
  filename.startsWith(`${slug}-`) && filename.toLowerCase().endsWith(".mp4");

/**
 * Whether an unclaimed root-level folder looks like it was once one of this
 * app's own track folders.
 *
 * Used only to decide whether an *orphaned* folder (one no active track's
 * delivery folder resolves to) is worth mentioning at all. Bookkeeping files
 * are unambiguous; an export file is recognised only against the *current*
 * preset ids here, deliberately narrower than `looksLikeManagedExportFile` —
 * an orphan is worth a look specifically when it still carries today's naming,
 * which is what a track renamed or removed recently leaves behind.
 */
export const looksLikeManagedTrackFolder = (
  filenames: readonly string[],
  currentPresetIds: readonly string[],
): boolean =>
  filenames.some(
    (name) =>
      isTrackBookkeepingFilename(name) ||
      currentPresetIds.some((presetId) =>
        name.toLowerCase().endsWith(`-${presetId}.mp4`),
      ),
  );

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

export const describeDeliveredFileMissing = (
  relativePath: string,
  deliveredAt: string | null,
): string =>
  deliveredAt === null
    ? `${relativePath} was delivered, but is no longer there.`
    : `${relativePath} was delivered ${formatBundleTimestamp(deliveredAt)}, but is no longer there.`;

export const describeDeliveredFileChanged = (
  relativePath: string,
  detail: "replaced" | "symlinked" | "modified",
): string => {
  const what =
    detail === "symlinked"
      ? "has been replaced by a link"
      : detail === "replaced"
        ? "is not the file that was delivered"
        : "no longer matches what was delivered";
  return `${relativePath} ${what}.`;
};

export const describeTrackFolderMissing = (relativePath: string): string =>
  `The whole delivery folder is gone: ${relativePath}.`;

export const describeUnexpectedExportFile = (
  relativePath: string,
  bytes: number | null,
): string =>
  `${relativePath} looks like an export from this app, but no current delivery accounts for it` +
  (bytes === null ? "." : ` (${formatBytes(bytes)}).`);

export const describeUnexpectedTrackFolder = (folder: string): string =>
  `"${folder}" looks like a delivery folder, but no active track resolves to it.`;

export const describeDestinationFileUnreadable = (
  relativePath: string,
  reason: string,
): string => `${relativePath} could not be examined: ${reason}.`;

export const describeDestinationFolderUnreadable = (
  where: string,
  reason: string,
): string => `${where} could not be listed: ${reason}.`;

export const describeRootIdentityChanged = (root: string): string =>
  `${root} no longer names the same real directory at its configured path. It may have been replaced or redirected through a link.`;

export const describeReleaseBundleMissing = (): string =>
  "A delivery is recorded here, but no readable release bundle is available.";

export const describeReleaseBundleOutdated = (): string =>
  "The release bundle no longer matches current track and delivery state.";

export const describeReleaseBundlePairMismatch = (): string =>
  "release.json and release.md disagree with each other, not only with current state.";

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

export type DestinationTrackHealth = {
  readonly slug: string;
  /** The track's effective folder inside the destination, when known. */
  readonly folder: string | null;
  readonly findings: readonly DestinationFinding[];
};

export type DestinationHealthCounts = {
  readonly tracksChecked: number;
  readonly healthyTracks: number;
  readonly tracksWithFindings: number;
  readonly totalFindings: number;
  readonly findingsBySeverity: {
    readonly info: number;
    readonly warning: number;
    readonly error: number;
  };
};

/**
 * Rolls per-track findings and root-level findings into one set of counts.
 *
 * A pure transform over data already gathered, exactly like
 * `summarizeDeliveryHistory` — nothing here touches a filesystem.
 */
export const summarizeDestinationHealth = (
  tracks: readonly DestinationTrackHealth[],
  rootFindings: readonly DestinationFinding[],
): DestinationHealthCounts => {
  const all = [...rootFindings, ...tracks.flatMap((track) => track.findings)];
  const bySeverity = { info: 0, warning: 0, error: 0 };

  for (const finding of all) bySeverity[finding.severity] += 1;

  return {
    tracksChecked: tracks.length,
    healthyTracks: tracks.filter((track) => track.findings.length === 0).length,
    tracksWithFindings: tracks.filter((track) => track.findings.length > 0).length,
    totalFindings: all.length,
    findingsBySeverity: bySeverity,
  };
};

/**
 * The one overall answer, derived from what the scan could and could not do.
 *
 * `unavailable` and `error` both mean "no usable answer", kept apart on
 * purpose: `unavailable` is the destination itself being unreachable — the
 * same fact delivery and release bundles already report as `rootProblem` —
 * while `error` means the scan reached the destination but something about
 * running it failed in a way that leaves the result incomplete or untrusted.
 * `drift` versus `healthy` is simply whether anything was found.
 */
export const deriveDestinationHealthStatus = (input: {
  readonly configured: boolean;
  readonly rootAvailable: boolean;
  readonly scanFailed: boolean;
  readonly totalFindings: number;
}): DestinationHealthStatus => {
  if (!input.configured) return "not_configured";
  if (!input.rootAvailable) return "unavailable";
  if (input.scanFailed) return "error";
  return input.totalFindings > 0 ? "drift" : "healthy";
};
