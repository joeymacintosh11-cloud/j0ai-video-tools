import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  deliveryFolderFor,
  type DeliveryReason,
} from "../../core/domain/delivery/deliveryPaths.ts";
import {
  readMarkdownBundleId,
  RELEASE_BUNDLE_SCHEMA_VERSION,
  RELEASE_JSON_FILENAME,
  RELEASE_MARKDOWN_FILENAME,
  releaseBundleFingerprintText,
  renderReleaseMarkdown,
  shortBundleId,
  type ReleaseBundle,
  type ReleaseBundleFingerprintInput,
  type ReleaseBundleFreshness,
  type ReleaseBundleTrack,
  type ReleaseFormatEntry,
  type ReleaseFormatStatus,
} from "../../core/domain/delivery/releaseBundle.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import type { TrackInspection } from "../../core/domain/tracks/types.ts";
import { secondsToFrames } from "../../core/domain/video/compositionConfig.ts";
import {
  RENDER_PRESETS,
  resolveExportPresets,
  type RenderPresetId,
} from "../../core/domain/video/renderPresets.ts";
import { withFileMutation, writeAtomicFile } from "../tracks/atomicFile.ts";
import { probeAudioDurationInSeconds } from "../tracks/audioDuration.ts";
import {
  trackExportCoverage,
  type ExportFileFacts,
} from "../tracks/exportCoverage.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { trackLocations } from "../tracks/trackLocations.ts";
import {
  assertDeliveryDestination,
  directoryIdentity,
} from "./deliveryDestination.ts";
import { deliveryStateForTarget } from "./deliverExport.ts";
import { readDeliveryReceipt } from "./deliveryReceipt.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "./deliverySettings.ts";

/**
 * Generates and reads a track's release bundle.
 *
 * The bundle is derived entirely from disk: metadata as validated, the track's
 * declared intent, the canonical export manifests, and the delivery receipts.
 * An MP4 sitting at the destination is never itself taken as evidence that
 * something shipped — only a receipt that still matches the current export is.
 *
 * Freshness costs a small read and the state already gathered for the track
 * view, so it can be reported while browsing. Generation additionally reads the
 * source audio's duration once per track. Nothing here hashes or decodes a
 * video.
 */

export type ReleaseBundleState = {
  readonly slug: string;
  readonly freshness: ReleaseBundleFreshness;
  /** The track's folder name inside the destination, or null when off. */
  readonly folder: string | null;
  /** Portable location, e.g. "Ghetto Geek/release.json". Null when off. */
  readonly relativePath: string | null;
  /** Fingerprint of the delivery state as it stands now. */
  readonly bundleId: string | null;
  /** Fingerprint the bundle on disk carries, when there is one. */
  readonly publishedBundleId: string | null;
  readonly generatedAt: string | null;
  readonly delivered: number;
  readonly outdated: number;
  readonly missing: number;
  /** Why no bundle can be described for this track at all. */
  readonly problem: string | null;
};

const unavailable = (
  slug: string,
  freshness: ReleaseBundleFreshness,
  problem: string | null = null,
): ReleaseBundleState => ({
  slug,
  freshness,
  folder: null,
  relativePath: null,
  bundleId: null,
  publishedBundleId: null,
  generatedAt: null,
  delivered: 0,
  outdated: 0,
  missing: 0,
  problem,
});

const fingerprint = (input: ReleaseBundleFingerprintInput): string =>
  createHash("sha256").update(releaseBundleFingerprintText(input)).digest("hex");

/** Both bundle files, addressed the same way a delivered video is. */
export const releaseBundlePaths = (
  root: string,
  folder: string,
): { readonly json: string; readonly markdown: string } => ({
  json: assertDeliveryDestination(root, `${folder}/${RELEASE_JSON_FILENAME}`),
  markdown: assertDeliveryDestination(
    root,
    `${folder}/${RELEASE_MARKDOWN_FILENAME}`,
  ),
});

type FormatFacts = {
  readonly presetId: RenderPresetId;
  readonly status: ReleaseFormatStatus;
  readonly reason: DeliveryReason | null;
  readonly exportFingerprint: string | null;
  readonly deliveredAt: string | null;
  readonly deliveredBytes: number | null;
  readonly sourceOutput: string | null;
  readonly filename: string;
};

/**
 * Per-format facts, with the same vocabulary the delivery planner uses.
 *
 * A format whose export cannot ship reports what is wrong with the *export*
 * rather than with the copy: "not delivered yet" would be true but would point
 * at the wrong fix.
 */
const collectFormats = (
  inspection: TrackInspection,
  root: string,
  folder: string,
  intended: readonly RenderPresetId[],
  coverage: readonly ExportFileFacts[],
): readonly FormatFacts[] => {
  const declaredFolder = inspection.metadata?.deliveryFolder ?? null;

  return intended.map((presetId) => {
    const facts = coverage.find((entry) => entry.presetId === presetId);
    const receipt = readDeliveryReceipt(inspection.slug, presetId);
    const state = facts
      ? deliveryStateForTarget(
          inspection.slug,
          presetId,
          facts,
          root,
          declaredFolder,
        )
      : null;

    const notCurrent = facts === undefined || facts.freshness !== "current";
    const status: ReleaseFormatStatus =
      state?.status === "delivered"
        ? "delivered"
        : state?.status === "outdated"
          ? "outdated"
          : "missing";

    return {
      presetId,
      status,
      reason: notCurrent
        ? facts?.rendered
          ? "export_not_current"
          : "export_missing"
        : (state?.reason ?? null),
      exportFingerprint: facts?.inputFingerprint ?? null,
      // Only a confirmed delivery may claim a size or a date: for anything else
      // the receipt may describe a file that has since been replaced.
      deliveredAt: status === "delivered" ? (receipt?.deliveredAt ?? null) : null,
      deliveredBytes: status === "delivered" ? (receipt?.bytes ?? null) : null,
      sourceOutput:
        receipt === null
          ? null
          : `${receipt.sourceOutput.ino}:${receipt.sourceOutput.bytes}:${receipt.sourceOutput.mtimeMs}`,
      filename: path.basename(
        assertDeliveryDestination(
          root,
          `${folder}/${inspection.slug}-${presetId}.mp4`,
        ),
      ),
    };
  });
};

const trackOf = (inspection: TrackInspection): ReleaseBundleTrack => {
  const metadata = inspection.metadata!;

  return {
    slug: inspection.slug,
    title: metadata.title,
    artist: metadata.artist,
    key: metadata.key,
    bpm: metadata.bpm,
    ...(metadata.subtitle ? { subtitle: metadata.subtitle } : {}),
  };
};

type Gathered = {
  readonly inspection: TrackInspection;
  readonly folder: string;
  readonly intended: readonly RenderPresetId[];
  readonly formats: readonly FormatFacts[];
  readonly bundleId: string;
  readonly paths: { readonly json: string; readonly markdown: string };
};

/** Everything a bundle needs except the media durations, which cost a probe. */
const gather = (
  inspection: TrackInspection,
  root: string,
  /** Reused when the caller already has it; a listing computes it once. */
  coverage?: readonly ExportFileFacts[],
): Gathered | { readonly problem: string } => {
  if (!inspection.facts.trackDirExists) {
    return { problem: `Track "${inspection.slug}" not found.` };
  }
  if (inspection.metadata === null) {
    const first = inspection.validation.errors[0];
    return {
      problem:
        first?.message ??
        `Track "${inspection.slug}" has no valid metadata, so nothing can be described.`,
    };
  }

  const folder = deliveryFolderFor(
    inspection.slug,
    inspection.metadata.deliveryFolder,
  );
  const intended = resolveExportPresets(inspection.metadata.exportPresets);
  const formats = collectFormats(
    inspection,
    root,
    folder,
    intended,
    coverage ?? trackExportCoverage(inspection.slug, inspection.metadata),
  );

  return {
    inspection,
    folder,
    intended,
    formats,
    bundleId: fingerprint({
      schemaVersion: RELEASE_BUNDLE_SCHEMA_VERSION,
      slug: inspection.slug,
      folder,
      track: trackOf(inspection),
      intendedPresets: intended,
      formats: formats.map(
        ({
          presetId,
          status,
          reason,
          exportFingerprint,
          deliveredAt,
          deliveredBytes,
          sourceOutput,
        }) => ({
          presetId,
          status,
          reason,
          exportFingerprint,
          deliveredAt,
          deliveredBytes,
          sourceOutput,
        }),
      ),
    }),
    paths: releaseBundlePaths(root, folder),
  };
};

/** The bundle on disk, or null when there is none worth trusting. */
const readPublished = (
  paths: Gathered["paths"],
  slug: string,
): { readonly bundle: ReleaseBundle; readonly markdownId: string | null } | null => {
  // O_NOFOLLOW closes the leaf-symlink race between a path check and a read.
  // These files are small text records; there is no reason to read a link.
  const readRegular = (file: string): string => {
    const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (!fstatSync(fd).isFile()) throw new Error("Bundle entry is not a regular file.");
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  };
  try {
    const bundle = JSON.parse(readRegular(paths.json)) as ReleaseBundle;

    const valid =
      bundle?.schemaVersion === RELEASE_BUNDLE_SCHEMA_VERSION &&
      bundle.track?.slug === slug &&
      typeof bundle.bundleId === "string" &&
      bundle.bundleId.length > 0 &&
      typeof bundle.generatedAt === "string";

    if (!valid) return null;

    let markdownId: string | null = null;
    try {
      markdownId = readMarkdownBundleId(readRegular(paths.markdown));
    } catch {
      markdownId = null;
    }

    return { bundle, markdownId };
  } catch {
    return null;
  }
};

/**
 * Whether a track's bundle still describes what is at the destination.
 *
 * Cheap on purpose: no duration probe and no video read, so this can be
 * reported for every track while browsing. Comparing fingerprints rather than
 * modification times means editing a bundle by hand, or touching it, cannot
 * make it look current.
 */
export const releaseBundleState = async (
  slugInput: string,
  settings?: DeliverySettings,
): Promise<ReleaseBundleState> => {
  const slug = assertValidSlug(slugInput);
  const resolved = settings ?? (await readDeliverySettings());
  const { root } = resolveDeliveryRoot(resolved);

  if (root === null) return unavailable(slug, "not_configured");

  return releaseBundleStateFor(await inspectTrack(slug), root);
};

/** The same answer from an inspection a caller already has. */
export const releaseBundleStateFor = (
  inspection: TrackInspection,
  root: string | null,
  /** Reused when the caller already has it; a listing computes it once. */
  coverage?: readonly ExportFileFacts[],
): ReleaseBundleState => {
  const slug = inspection.slug;

  if (root === null) return unavailable(slug, "not_configured");

  let gathered: Gathered | { readonly problem: string };
  try {
    gathered = gather(inspection, root, coverage);
  } catch (error) {
    return unavailable(
      slug,
      "missing",
      error instanceof Error ? error.message : String(error),
    );
  }

  if ("problem" in gathered) return unavailable(slug, "missing", gathered.problem);

  const counts = {
    delivered: gathered.formats.filter((f) => f.status === "delivered").length,
    outdated: gathered.formats.filter((f) => f.status === "outdated").length,
    missing: gathered.formats.filter((f) => f.status === "missing").length,
  };
  const published = readPublished(gathered.paths, slug);
  const relativePath = `${gathered.folder}/${RELEASE_JSON_FILENAME}`;

  // A pair whose two files disagree is treated as outdated: they cannot be
  // renamed into place together, so the only guard is that both carry the same
  // id, and republishing is what repairs it.
  const freshness: ReleaseBundleFreshness =
    published === null
      ? "missing"
      : published.bundle.bundleId === gathered.bundleId &&
          published.markdownId === shortBundleId(gathered.bundleId)
        ? "current"
        : "outdated";

  return {
    slug,
    freshness,
    folder: gathered.folder,
    relativePath,
    bundleId: gathered.bundleId,
    publishedBundleId: published?.bundle.bundleId ?? null,
    generatedAt: published?.bundle.generatedAt ?? null,
    ...counts,
    problem: null,
  };
};

/**
 * The rendered length of this track, from its source audio.
 *
 * The same calculation the composition makes, so the reported duration is the
 * one that was rendered rather than a re-measurement of the output. One probe
 * per track — ffprobe reads the header, not the samples — and a track whose
 * audio cannot be read still gets a bundle, with the duration left out.
 */
const durationFor = async (
  slug: string,
): Promise<((fps: number) => { seconds: number; frames: number }) | null> => {
  try {
    const seconds = await probeAudioDurationInSeconds(trackLocations(slug).beat);

    return (fps: number) => {
      const frames = secondsToFrames(seconds, fps);
      return { seconds: frames / fps, frames };
    };
  } catch {
    return null;
  }
};

const toEntry = (
  facts: FormatFacts,
  duration: Awaited<ReturnType<typeof durationFor>>,
): ReleaseFormatEntry => {
  const preset = RENDER_PRESETS[facts.presetId];
  const measured = duration?.(preset.fps) ?? null;

  return {
    presetId: facts.presetId,
    label: preset.shortLabel,
    filename: facts.filename,
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
    status: facts.status,
    reason: facts.reason,
    durationSeconds: measured === null ? null : Number(measured.seconds.toFixed(3)),
    durationFrames: measured?.frames ?? null,
    bytes: facts.deliveredBytes,
    deliveredAt: facts.deliveredAt,
    exportFingerprint: facts.exportFingerprint,
  };
};

export type GenerateReleaseBundleResult = {
  readonly slug: string;
  readonly generated: boolean;
  readonly freshness: ReleaseBundleFreshness;
  readonly relativePath: string | null;
  readonly bundleId: string | null;
  readonly delivered: number;
  readonly outdated: number;
  readonly missing: number;
  readonly problem: string | null;
};

/**
 * Writes a track's release bundle, unless it is already current.
 *
 * Publication order matters and is deliberate: the Markdown is renamed into
 * place first, the JSON second. The JSON is what freshness is read from, so a
 * crash between the two leaves the *old* id there and the bundle reads as
 * outdated — which regenerating repairs. Publishing the JSON first would make a
 * bundle claim to be current while its readable half was stale, which is worse
 * than being out of date.
 *
 * Neither file is touched until its replacement has been written in full, so a
 * previous valid bundle survives any failure.
 */
export const generateReleaseBundle = async ({
  slug: slugInput,
  settings,
  force = false,
  now = () => new Date().toISOString(),
}: {
  readonly slug: string;
  readonly settings?: DeliverySettings;
  /** Rewrite even when the bundle is already current. */
  readonly force?: boolean;
  /** Injected so the rendered document is reproducible in tests. */
  readonly now?: () => string;
}): Promise<GenerateReleaseBundleResult> => {
  const slug = assertValidSlug(slugInput);
  const resolved = settings ?? (await readDeliverySettings());
  const { root, problem } = resolveDeliveryRoot(resolved);

  const unchanged = (
    state: ReleaseBundleState,
    reason: string | null,
  ): GenerateReleaseBundleResult => ({
    slug,
    generated: false,
    freshness: state.freshness,
    relativePath: state.relativePath,
    bundleId: state.bundleId,
    delivered: state.delivered,
    outdated: state.outdated,
    missing: state.missing,
    problem: reason,
  });

  if (root === null) {
    return unchanged(
      unavailable(slug, "not_configured"),
      problem ?? "No export destination is configured, so there is nowhere for a bundle.",
    );
  }

  // Serialized per bundle within this process. Across processes the document is
  // a pure function of what is on disk, so two generators write the same bytes
  // and the later rename simply wins.
  const inspection = await inspectTrack(slug);
  const state = releaseBundleStateFor(inspection, root);

  if (state.problem !== null) return unchanged(state, state.problem);
  if (state.freshness === "current" && !force) return unchanged(state, null);

  const gathered = gather(inspection, root);
  if ("problem" in gathered) return unchanged(state, gathered.problem);

  const duration = await durationFor(slug);
  const entries = gathered.formats.map((facts) => toEntry(facts, duration));
  const bundle: ReleaseBundle = {
    schemaVersion: RELEASE_BUNDLE_SCHEMA_VERSION,
    bundleId: gathered.bundleId,
    generatedAt: now(),
    track: trackOf(inspection),
    folder: gathered.folder,
    intendedPresets: gathered.intended,
    deliveries: entries.filter((entry) => entry.status === "delivered"),
    outdated: entries.filter((entry) => entry.status === "outdated"),
    missing: entries.filter((entry) => entry.status === "missing"),
  };

  // Identity captured before the work, and compared again immediately before
  // writing: a root that has been unmounted or swapped must not be silently
  // recreated by mkdir, which would put a bundle inside an empty mount point.
  const rootIdentity = directoryIdentity(root);

  await withFileMutation(gathered.paths.json, async () => {
    assertDeliveryDestination(root, `${gathered.folder}/${RELEASE_JSON_FILENAME}`);
    if (directoryIdentity(root) !== rootIdentity) {
      throw new TrackError(
        trackIssue(
          "INVALID_REQUEST",
          `The export destination ${root} changed while the bundle was being written.`,
        ),
      );
    }

    // A bundle can precede any delivery, so the track's folder may not exist
    // yet. Created inside a root that has just been re-verified, and never
    // recursively, so the root itself is never conjured back into existence.
    await mkdir(path.dirname(gathered.paths.json), { recursive: false }).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      },
    );
    await writeAtomicFile(gathered.paths.markdown, (handle) =>
      handle.writeFile(renderReleaseMarkdown(bundle), "utf-8"),
    );
    await writeAtomicFile(gathered.paths.json, (handle) =>
      handle.writeFile(`${JSON.stringify(bundle, null, 2)}\n`, "utf-8"),
    );
  });

  return {
    slug,
    generated: true,
    freshness: "current",
    relativePath: state.relativePath,
    bundleId: gathered.bundleId,
    delivered: bundle.deliveries.length,
    outdated: bundle.outdated.length,
    missing: bundle.missing.length,
    problem: null,
  };
};
