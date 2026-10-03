import { resolveTrackRenderer } from "../../core/domain/video/renderers.ts";
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import {
  DESTINATION_FINDING_SEVERITY,
  deriveDestinationHealthStatus,
  describeDeliveredFileChanged,
  describeDeliveredFileMissing,
  describeDestinationFileUnreadable,
  describeDestinationFolderUnreadable,
  describeReleaseBundleMissing,
  describeReleaseBundleOutdated,
  describeReleaseBundlePairMismatch,
  describeRootIdentityChanged,
  describeTrackFolderMissing,
  describeUnexpectedExportFile,
  describeUnexpectedTrackFolder,
  destinationFinding,
  isIgnorableFilename,
  isTrackBookkeepingFilename,
  looksLikeManagedExportFile,
  looksLikeManagedTrackFolder,
  summarizeDestinationHealth,
  type DestinationFinding,
  type DestinationHealthCounts,
  type DestinationHealthStatus,
  type DestinationTrackHealth,
} from "../../core/domain/delivery/destinationHealth.ts";
import {
  readMarkdownBundleId,
  shortBundleId,
} from "../../core/domain/delivery/releaseBundle.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import type { TrackInspection } from "../../core/domain/tracks/types.ts";
import {
  deliveryFolderFor,
} from "../../core/domain/delivery/deliveryPaths.ts";
import { RENDER_PRESET_IDS } from "../../core/domain/video/renderPresets.ts";
import { deliveryStateFor, readDeliveryReceipt } from "../delivery/deliveryReceipt.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "../delivery/deliverySettings.ts";
import {
  releaseBundlePaths,
  releaseBundleStateFor,
} from "../delivery/releaseBundle.ts";
import { trackExportCoverage } from "../tracks/exportCoverage.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { listTracks } from "../tracks/listTracks.ts";

/**
 * Compares the destination's actual contents against what current records
 * expect, and reports drift without touching anything.
 *
 * "Expected" comes entirely from records the rest of the app already trusts:
 * a track's delivery receipts (each one a strong claim that a specific file
 * should exist and look a specific way), its release bundle state, and which
 * folders its receipts claim as its own. Nothing here re-derives any of that —
 * `deliveryStateForTarget` and `releaseBundleStateFor` are called exactly as
 * delivery and release bundles call them, so "drift" means one consistent
 * thing everywhere in the app.
 *
 * What this adds beyond those two is the part neither of them ever does:
 * actually listing the destination's folders and files, to find what current
 * records do *not* know about — a leftover export, an orphaned track folder,
 * a destination root that has quietly become a different directory than the
 * one that was configured.
 *
 * A scan is a snapshot, not a transaction: nothing is locked, and every
 * filesystem call is wrapped so a file vanishing between one call and the next
 * produces a coherent (if slightly stale) finding rather than a thrown error.
 * No finding here is ever acted on automatically.
 */

export type DestinationHealthResult = {
  readonly status: DestinationHealthStatus;
  readonly catalogue: boolean;
  readonly root: string | null;
  readonly rootProblem: string | null;
  readonly rootFindings: readonly DestinationFinding[];
  readonly tracks: readonly DestinationTrackHealth[];
  readonly counts: DestinationHealthCounts;
  readonly scannedAt: string;
  /** Named tracks that could not be scanned at all — not found locally. */
  readonly invalid: readonly { readonly slug: string; readonly reason: string }[];
};

export type ScanDestinationHealthInput = {
  readonly slugs?: readonly string[];
  readonly settings?: DeliverySettings;
};

const namedSlugs = (slugs: readonly string[]): readonly string[] => {
  if (slugs.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one track."),
    );
  }

  const seen = new Set<string>();
  const unique: string[] = [];

  for (const slug of slugs) {
    const valid = assertValidSlug(slug);
    if (!seen.has(valid)) {
      seen.add(valid);
      unique.push(valid);
    }
  }

  return unique;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const readRegularFile = (file: string): string => {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(fd).isFile()) throw new Error("Not a regular file.");
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
};

const empty = (
  status: DestinationHealthStatus,
  catalogue: boolean,
  rootProblem: string | null,
): DestinationHealthResult => ({
  status,
  catalogue,
  root: null,
  rootProblem,
  rootFindings: [],
  tracks: [],
  counts: summarizeDestinationHealth([], []),
  scannedAt: new Date().toISOString(),
  invalid: [],
});

/**
 * Whether a delivered-file state names destination drift, as opposed to
 * anything about the canonical export.
 *
 * `deliveryStateFor` answers a broader question than this scan asks: it also
 * reports when the *canonical* export is missing or stale, and when the
 * receipt points at a different destination entirely. None of that is drift
 * at *this* destination — it is either normal (nothing delivered there yet)
 * or a fact already reported elsewhere. Only these two reasons mean the copy
 * this destination is holding does not match what was recorded about it.
 */
const isDestinationDrift = (
  reason: string | null,
): reason is "destination_missing" | "destination_modified" =>
  reason === "destination_missing" || reason === "destination_modified";

/** "replaced", "symlinked" or "modified" — purely for a clearer message. */
const classifyModification = (
  destinationPath: string,
): "replaced" | "symlinked" | "modified" => {
  try {
    const link = lstatSync(destinationPath);
    if (link.isSymbolicLink()) return "symlinked";
    if (!link.isFile()) return "replaced";
    return "modified";
  } catch {
    return "modified";
  }
};

export const scanDestinationHealth = async (
  input: ScanDestinationHealthInput,
): Promise<DestinationHealthResult> => {
  const catalogue = input.slugs === undefined;
  const requested = input.slugs === undefined ? undefined : namedSlugs(input.slugs);
  const settings = input.settings ?? (await readDeliverySettings());
  // Refuse a link before resolveDeliveryRoot follows it to inspect the target.
  // The configured value is normally canonicalized when settings are written.
  if (settings.root !== null) {
    try {
      if (realpathSync(settings.root) !== settings.root ||
          !lstatSync(settings.root).isDirectory()) {
        const finding = destinationFinding(
          "destination_root_identity_changed",
          describeRootIdentityChanged(settings.root),
        );
        return {
          status: "error", catalogue, root: settings.root, rootProblem: null,
          rootFindings: [finding], tracks: [],
          counts: summarizeDestinationHealth([], [finding]),
          scannedAt: new Date().toISOString(), invalid: [],
        };
      }
    } catch {
      // Let resolveDeliveryRoot supply its existing unavailable response.
    }
  }
  const { root, problem } = resolveDeliveryRoot(settings);

  if (root === null) {
    return empty(
      deriveDestinationHealthStatus({
        configured: settings.root !== null,
        rootAvailable: false,
        scanFailed: false,
        totalFindings: 0,
      }),
      catalogue,
      problem,
    );
  }

  const rootFindings: DestinationFinding[] = [];
  // Individual entry failures become findings. A root identity change makes
  // the remaining result untrusted, so it stops the scan with `error` status.
  let scanFailed = false;

  // The configured path must still name the same real directory throughout
  // this scan. In particular, do not merely report a symlinked replacement and
  // then continue walking through it. Synchronous destination operations keep
  // this check and each read in the same event-loop turn.
  let pinnedRoot: string | null = null;
  const rootIsSafe = (): boolean => {
    if (scanFailed) return false;
    try {
      const entry = lstatSync(root);
      if (entry.isDirectory() && settings.root === root && realpathSync(root) === root) {
        const identity = `${entry.dev}:${entry.ino}`;
        if (pinnedRoot === null) pinnedRoot = identity;
        if (pinnedRoot === identity) return true;
      }
      rootFindings.push(destinationFinding(
        "destination_root_identity_changed",
        describeRootIdentityChanged(settings.root ?? root),
      ));
    } catch (error) {
      rootFindings.push(destinationFinding(
        "destination_folder_unreadable",
        describeDestinationFolderUnreadable("The export destination", errorMessage(error)),
      ));
    }
    scanFailed = true;
    return false;
  };

  const finish = (tracks: DestinationTrackHealth[], invalid: DestinationHealthResult["invalid"]): DestinationHealthResult => {
    const counts = summarizeDestinationHealth(tracks, rootFindings);
    return {
      status: deriveDestinationHealthStatus({
        configured: true, rootAvailable: true,
        scanFailed: scanFailed || (!catalogue && invalid.length > 0),
        totalFindings: counts.totalFindings,
      }),
      catalogue, root, rootProblem: null, rootFindings, tracks, counts,
      scannedAt: new Date().toISOString(), invalid,
    };
  };

  if (!rootIsSafe()) return finish([], []);

  const invalid: { readonly slug: string; readonly reason: string }[] = [];
  const inspections: readonly TrackInspection[] = catalogue
    ? await listTracks()
    : await Promise.all((requested ?? []).map(inspectTrack));

  if (!rootIsSafe()) return finish([], invalid);

  // The configured root's own identity, checked once. `resolveDeliveryRoot`
  // re-resolves the stored path fresh every call, so if that path has quietly
  // started resolving somewhere else — a parent directory swapped, or the leaf
  // itself replaced by a symlink — it would otherwise be followed in silence.
  // rootIsSafe above checks both canonical path and dev:ino; subsequent reads
  // repeat it so a replacement during the local track inspection is noticed.

  // The root's own listing, used only for orphaned-folder detection, and only
  // for a catalogue-wide scan: judging whether a folder is "orphaned" requires
  // knowing every active track's folder, which a narrowed request does not
  // have loaded.
  let rootEntries: readonly import("node:fs").Dirent[] | null = null;
  if (catalogue) {
    try {
      rootEntries = readdirSync(root, { withFileTypes: true });
    } catch (error) {
      rootFindings.push(
        destinationFinding(
          "destination_folder_unreadable",
          describeDestinationFolderUnreadable(
            "The export destination",
            errorMessage(error),
          ),
        ),
      );
    }
  }

  const tracks: DestinationTrackHealth[] = [];

  for (const inspection of inspections) {
    if (!rootIsSafe()) break;
    const slug = inspection.slug;

    if (!inspection.facts.trackDirExists) {
      invalid.push({ slug, reason: `Track "${slug}" not found.` });
      continue;
    }

    let folder: string | null;
    try {
      folder = deliveryFolderFor(slug, inspection.metadata?.deliveryFolder ?? undefined);
    } catch (error) {
      invalid.push({ slug, reason: errorMessage(error) });
      continue;
    }

    const findings: DestinationFinding[] = [];
    const renderer = resolveTrackRenderer(inspection.metadata?.renderer);
    const coverage = trackExportCoverage(slug, inspection.metadata, renderer);
    const coveredBasenames = new Set<string>();

    // Every receipt this track has, for every preset — not only its currently
    // intended formats. A receipt is a strong claim regardless of whether the
    // format is still intended today, and a format dropped from intent does
    // not un-deliver a file that is genuinely still sitting there.
    for (const presetId of RENDER_PRESET_IDS) {
      if (!rootIsSafe()) break;
      const facts = coverage.find((entry) => entry.presetId === presetId);
      if (facts === undefined) continue;

      const deliveredPath = path.join(root, folder, `${slug}-${presetId}.mp4`);
      // A link is already a changed delivered entry; never inspect its target,
      // even when it has matching size and mtime.
      const receipt = readDeliveryReceipt(slug, presetId, renderer) ??
        readDeliveryReceipt(slug, presetId, renderer === "after-effects" ? "remotion" : "after-effects");
      if (receipt !== null && receipt.destinationRoot === root &&
          receipt.destinationRelativePath === `${folder}/${slug}-${presetId}.mp4`) {
        try {
          if (lstatSync(deliveredPath).isSymbolicLink()) {
            coveredBasenames.add(path.basename(deliveredPath));
            findings.push(destinationFinding(
              "delivered_file_changed",
              describeDeliveredFileChanged(`${folder}/${path.basename(deliveredPath)}`, "symlinked"),
              { slug, presetId, relativePath: `${folder}/${path.basename(deliveredPath)}` },
            ));
            continue;
          }
        } catch { /* The shared state helper classifies the missing entry. */ }
      }

      const state = deliveryStateFor(facts, receipt, root, `${folder}/${slug}-${presetId}.mp4`);

      if (receipt !== null && receipt.destinationRoot === root &&
          receipt.destinationRelativePath === `${folder}/${slug}-${presetId}.mp4`) {
        coveredBasenames.add(path.basename(receipt.destinationRelativePath));
      }

      if (!isDestinationDrift(state.reason)) continue;

      const relativePath = state.destinationRelativePath ?? "";

      if (state.reason === "destination_missing") {
        // "destination_missing" collapses several causes: a plain ENOENT, but
        // also a path `assertDeliveryDestination` refused (its parent became a
        // symlink) or an inaccessible entry. `lstat`
        // distinguishes "genuinely nothing there" from "something is there but
        // could not be read as expected" — a materially different, more
        // actionable fact — without altering what `deliveryStateFor` itself
        // decided.
        const leaf = state.destinationPath ?? path.join(root, relativePath);
        let unreadableReason: string | null = null;
        try {
          lstatSync(leaf);
          unreadableReason = "an entry is there, but could not be read as the delivered file";
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            unreadableReason = errorMessage(error);
          }
        }

        findings.push(
          unreadableReason !== null
            ? destinationFinding(
                "destination_file_unreadable",
                describeDestinationFileUnreadable(relativePath, unreadableReason),
                { slug, presetId, relativePath },
              )
            : destinationFinding(
                "delivered_file_missing",
                describeDeliveredFileMissing(relativePath, state.deliveredAt),
                { slug, presetId, relativePath },
              ),
        );
      } else {
        const detail = classifyModification(state.destinationPath ?? "");
        findings.push(
          destinationFinding(
            "delivered_file_changed",
            describeDeliveredFileChanged(relativePath, detail),
            { slug, presetId, relativePath },
          ),
        );
      }
    }

    const folderPath = path.join(root, folder);
    let folderExists = false;
    let folderUnreadable: string | null = null;
    try {
      const entry = lstatSync(folderPath);
      folderExists = entry.isDirectory();
      if (!folderExists) folderUnreadable = "the entry is not a real directory";
    } catch (error) {
      // ENOENT means genuinely missing; anything else (EACCES, most commonly)
      // means it could not be seen — a materially different fact. Reporting a
      // permissions problem as "the folder is gone" would send someone to
      // re-deliver a track whose files were never actually lost.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        folderUnreadable = errorMessage(error);
      }
      folderExists = false;
    }

    if (folderUnreadable !== null) {
      findings.push(
        destinationFinding(
          "destination_folder_unreadable",
          describeDestinationFolderUnreadable(folder, folderUnreadable),
          { slug, relativePath: folder },
        ),
      );
    } else if (!folderExists && coveredBasenames.size > 0) {
      findings.push(
        destinationFinding(
          "track_folder_missing",
          describeTrackFolderMissing(folder),
          { slug, relativePath: folder },
        ),
      );
    } else if (folderExists && rootIsSafe()) {
      try {
        const current = lstatSync(folderPath);
        if (!current.isDirectory() || realpathSync(folderPath) !== folderPath) {
          throw new Error("The delivery folder was replaced before it could be listed.");
        }
        const entries = readdirSync(folderPath, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isFile() && !entry.isSymbolicLink()) continue;

          const name = entry.name;
          if (isIgnorableFilename(name) || isTrackBookkeepingFilename(name)) continue;
          if (!looksLikeManagedExportFile(name, slug)) continue;
          if (coveredBasenames.has(name)) continue;

          let bytes: number | null = null;
          try {
            if (entry.isFile()) bytes = lstatSync(path.join(folderPath, name)).size;
          } catch {
            bytes = null;
          }

          const relativePath = `${folder}/${name}`;
          findings.push(
            destinationFinding(
              "unexpected_export_file",
              describeUnexpectedExportFile(relativePath, bytes),
              { slug, relativePath },
            ),
          );
        }
      } catch (error) {
        findings.push(
          destinationFinding(
            "destination_folder_unreadable",
            describeDestinationFolderUnreadable(folder, errorMessage(error)),
            { slug, relativePath: folder },
          ),
        );
      }
    }

    // Release bundle health, entirely delegated to the same freshness function
    // delivery already trusts. The one thing added here is a light, read-only
    // comparison of the two files' own ids against each other, which
    // distinguishes "these files disagree with each other" from "this bundle
    // is simply behind current state" — a genuinely different, more actionable
    // fact — without re-implementing any part of the freshness algorithm.
    if (!rootIsSafe()) break;
    if (folderUnreadable !== null) {
      tracks.push({ slug, folder, findings });
      continue;
    }
    // Bundle freshness reads both published files. Refuse link leaves before
    // delegating so that readPublished cannot follow them outside the root.
    let linkedBundlePath: string | null = null;
    try {
      const paths = releaseBundlePaths(root, folder);
      for (const file of [paths.json, paths.markdown]) {
        try {
          const entry = lstatSync(file);
          if (!entry.isFile()) linkedBundlePath = file;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") linkedBundlePath = file;
        }
      }
    } catch {
      // The delegated state handles an unavailable folder.
    }
    if (linkedBundlePath !== null) {
      const relativePath = path.relative(root, linkedBundlePath);
      findings.push(destinationFinding(
        "destination_file_unreadable",
        describeDestinationFileUnreadable(relativePath, "not a regular file"),
        { slug, relativePath },
      ));
      tracks.push({ slug, folder, findings });
      continue;
    }
    const bundleState = releaseBundleStateFor(inspection, root, coverage);
    if (bundleState.freshness === "missing") {
      if (coveredBasenames.size > 0 && bundleState.problem === null) {
        findings.push(
          destinationFinding("release_bundle_missing", describeReleaseBundleMissing(), {
            slug,
            relativePath: `${folder}/release.json`,
          }),
        );
      }
    } else if (bundleState.freshness === "outdated" && bundleState.folder !== null) {
      let pairMismatch = false;
      try {
        const paths = releaseBundlePaths(root, bundleState.folder);
        const jsonId = (
          JSON.parse(readRegularFile(paths.json)) as { bundleId?: unknown }
        ).bundleId;
        const markdownId = readMarkdownBundleId(readRegularFile(paths.markdown));
        if (
          typeof jsonId === "string" &&
          markdownId !== null &&
          markdownId !== shortBundleId(jsonId)
        ) {
          pairMismatch = true;
        }
      } catch {
        // One or both files missing or unreadable — not a disagreement
        // between two present files, so the general "outdated" finding below
        // is the accurate one.
      }

      findings.push(
        pairMismatch
          ? destinationFinding(
              "release_bundle_pair_mismatch",
              describeReleaseBundlePairMismatch(),
              { slug, relativePath: bundleState.relativePath },
            )
          : destinationFinding(
              "release_bundle_outdated",
              describeReleaseBundleOutdated(),
              { slug, relativePath: bundleState.relativePath },
            ),
      );
    }

    tracks.push({ slug, folder, findings });
  }

  // Orphaned top-level folders: only ever attempted for a catalogue-wide scan,
  // and only ever a mention (`info`), never treated as something broken —
  // whatever it is, it is not touched.
  if (rootEntries !== null) {
    const activeFolders = new Set(
      tracks.map((track) => track.folder).filter((name): name is string => name !== null),
    );

    for (const entry of rootEntries) {
      if (!rootIsSafe()) break;
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (isIgnorableFilename(name) || activeFolders.has(name)) continue;

      let innerNames: readonly string[];
      try {
        const folderPath = path.join(root, name);
        if (!lstatSync(folderPath).isDirectory() || realpathSync(folderPath) !== folderPath) {
          continue;
        }
        innerNames = (
          readdirSync(folderPath, { withFileTypes: true })
        )
          .filter((inner) => inner.isFile())
          .map((inner) => inner.name);
      } catch {
        continue;
      }

      if (looksLikeManagedTrackFolder(innerNames, RENDER_PRESET_IDS)) {
        rootFindings.push(
          destinationFinding("unexpected_track_folder", describeUnexpectedTrackFolder(name), {
            relativePath: name,
          }),
        );
      }
    }
  }

  return finish(tracks, invalid);
};

// Re-exported so a caller can report a finding's severity without importing
// the domain module directly for just this one lookup.
export { DESTINATION_FINDING_SEVERITY };
