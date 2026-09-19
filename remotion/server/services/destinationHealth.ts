import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
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
} from "../../src/domain/delivery/destinationHealth.ts";
import {
  readMarkdownBundleId,
  shortBundleId,
} from "../../src/domain/delivery/releaseBundle.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import type { TrackInspection } from "../../src/domain/tracks/types.ts";
import {
  deliveryFolderFor,
} from "../../src/domain/delivery/deliveryPaths.ts";
import { RENDER_PRESET_IDS } from "../../src/domain/video/renderPresets.ts";
import { deliveryStateForTarget } from "../../services/delivery/deliverExport.ts";
import { readDeliveryReceipt } from "../../services/delivery/deliveryReceipt.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "../../services/delivery/deliverySettings.ts";
import {
  releaseBundlePaths,
  releaseBundleStateFor,
} from "../../services/delivery/releaseBundle.ts";
import { trackExportCoverage } from "../../services/tracks/exportCoverage.ts";
import { inspectTrack } from "../../services/tracks/inspectTrack.ts";
import { listTracks } from "../../services/tracks/listTracks.ts";

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
  const settings = input.settings ?? (await readDeliverySettings());
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

  const invalid: { readonly slug: string; readonly reason: string }[] = [];
  const inspections: readonly TrackInspection[] = catalogue
    ? await listTracks()
    : await Promise.all(namedSlugs(input.slugs ?? []).map(inspectTrack));

  const rootFindings: DestinationFinding[] = [];
  // Every per-item failure below is caught and turned into a finding rather
  // than aborting the scan — a permissions error on one track's folder must
  // not stop the rest from being checked. `error` status is reserved for a
  // scan that could not run at all, which would surface as a thrown exception
  // from this function rather than as a value it returns; nothing here needs
  // to set it.
  const scanFailed = false;

  // The configured root's own identity, checked once. `resolveDeliveryRoot`
  // re-resolves the stored path fresh every call, so if that path has quietly
  // started resolving somewhere else — a parent directory swapped, or the leaf
  // itself replaced by a symlink — it would otherwise be followed in silence.
  try {
    if (settings.root !== null && realpathSync(settings.root) !== settings.root) {
      rootFindings.push(
        destinationFinding(
          "destination_root_identity_changed",
          describeRootIdentityChanged(settings.root),
        ),
      );
    }
  } catch {
    // Transient — the root resolved fine a moment ago in resolveDeliveryRoot();
    // not worth failing the whole scan over a single re-check.
  }

  // The root's own listing, used only for orphaned-folder detection, and only
  // for a catalogue-wide scan: judging whether a folder is "orphaned" requires
  // knowing every active track's folder, which a narrowed request does not
  // have loaded.
  let rootEntries: readonly import("node:fs").Dirent[] | null = null;
  if (catalogue) {
    try {
      rootEntries = await readdir(root, { withFileTypes: true });
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
    const coverage = trackExportCoverage(slug, inspection.metadata);
    const coveredBasenames = new Set<string>();

    // Every receipt this track has, for every preset — not only its currently
    // intended formats. A receipt is a strong claim regardless of whether the
    // format is still intended today, and a format dropped from intent does
    // not un-deliver a file that is genuinely still sitting there.
    for (const presetId of RENDER_PRESET_IDS) {
      const facts = coverage.find((entry) => entry.presetId === presetId);
      if (facts === undefined) continue;

      const state = deliveryStateForTarget(slug, presetId, facts, root, folder);

      const receipt = readDeliveryReceipt(slug, presetId);
      if (receipt !== null && receipt.destinationRoot === root) {
        coveredBasenames.add(path.basename(receipt.destinationRelativePath));
      }

      if (!isDestinationDrift(state.reason)) continue;

      const relativePath = state.destinationRelativePath ?? "";

      if (state.reason === "destination_missing") {
        // "destination_missing" collapses several causes: a plain ENOENT, but
        // also a path `assertDeliveryDestination` refused (its parent became a
        // symlink) or a broken symlink `statSync` could not follow. `lstat`
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
      folderExists = lstatSync(folderPath).isDirectory();
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
    } else if (folderExists) {
      try {
        const entries = await readdir(folderPath, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isFile() && !entry.isSymbolicLink()) continue;

          const name = entry.name;
          if (isIgnorableFilename(name) || isTrackBookkeepingFilename(name)) continue;
          if (!looksLikeManagedExportFile(name, slug)) continue;
          if (coveredBasenames.has(name)) continue;

          let bytes: number | null = null;
          try {
            bytes = statSync(path.join(folderPath, name)).size;
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
    const bundleState = releaseBundleStateFor(inspection, root, coverage);
    if (bundleState.freshness === "missing") {
      if (coveredBasenames.size > 0) {
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
          JSON.parse(readFileSync(paths.json, "utf8")) as { bundleId?: unknown }
        ).bundleId;
        const markdownId = readMarkdownBundleId(readFileSync(paths.markdown, "utf8"));
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
      if (!entry.isDirectory()) continue;
      const name = entry.name;
      if (isIgnorableFilename(name) || activeFolders.has(name)) continue;

      let innerNames: readonly string[];
      try {
        innerNames = (
          await readdir(path.join(root, name), { withFileTypes: true })
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

  const counts = summarizeDestinationHealth(tracks, rootFindings);

  return {
    status: deriveDestinationHealthStatus({
      configured: true,
      rootAvailable: true,
      scanFailed,
      totalFindings: counts.totalFindings,
    }),
    catalogue,
    root,
    rootProblem: null,
    rootFindings,
    tracks,
    counts,
    scannedAt: new Date().toISOString(),
    invalid,
  };
};

// Re-exported so a caller can report a finding's severity without importing
// the domain module directly for just this one lookup.
export { DESTINATION_FINDING_SEVERITY };
