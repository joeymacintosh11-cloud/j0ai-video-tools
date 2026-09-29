import { createHash } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import {
  CONTENT_LIBRARY_SCHEMA_VERSION,
  libraryRecordIdText,
  type ContentLibraryRecord,
  type LibraryRecordIdentity,
  type LibraryTrackSnapshot,
} from "../../src/domain/library/contentLibrary.ts";
import { outputLabel } from "../../src/domain/tracks/paths.ts";
import { isValidSlug } from "../../src/domain/tracks/slug.ts";
import type { TrackMetadata } from "../../src/domain/tracks/types.ts";
import { COMPOSITION_ID } from "../../src/domain/video/compositionConfig.ts";
import { VISUALIZER_VERSION } from "../../src/domain/video/exportFreshness.ts";
import {
  RENDER_PRESET_LIST,
  renderPreset,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import { publishExport } from "../render/publishExport.ts";
import { withRenderTargetLock, type RenderTargetLock } from "../render/renderLock.ts";
import { trackExportCoverage } from "../tracks/exportCoverage.ts";
import {
  compareInputs,
  readExportManifest,
  type ExportInputs,
  type ExportManifest,
} from "../tracks/exportManifest.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { TRACKS_DIR, trackOutputLocation } from "../tracks/trackLocations.ts";
import {
  appendContentLibraryRecord,
  contentLibraryRoot,
  type AppendContentLibraryResult,
} from "./contentLibraryLog.ts";

/**
 * Records a completed export in the content library.
 *
 * The one entry point renders use is `publishRecordedExport`, a wrapper around
 * the existing `publishExport` that renderTrackVideo (the path every CLI and
 * worker render already shares) calls instead of it. That placement is what
 * gives the library its guarantees without anything else changing:
 *
 * - **Only completed exports are recorded.** The record is written after
 *   `publishExport` returns, and `publishExport` only returns once the new
 *   video and manifest are atomically in place. A failed render, a cancelled
 *   one, or one refused before it started throws out of that call first, so
 *   there is no code path on which a failure produces a record.
 * - **"What did this replace" is exact.** The previous manifest is read under
 *   the render target's lock immediately before publishing, and the new one
 *   immediately after, so no other process can publish in between.
 * - **Recording never fails a render.** The append reports a result instead of
 *   throwing; a render whose export is already published returns normally.
 */

export type ExportBeforePublish = {
  /** A non-empty file was at the canonical path — this publish replaces it. */
  readonly hadOutput: boolean;
  /** Its manifest, when that was valid. */
  readonly previous: ExportManifest | null;
};

const hashId = (identity: LibraryRecordIdentity): string =>
  createHash("sha256").update(libraryRecordIdText(identity)).digest("hex").slice(0, 32);

export const libraryRecordIdFor = (
  slug: string,
  presetId: string,
  manifest: Pick<ExportManifest, "renderedAt" | "inputFingerprint" | "output">,
): string =>
  hashId({
    slug,
    presetId,
    generatedAt: manifest.renderedAt,
    inputFingerprint: manifest.inputFingerprint,
    bytes: manifest.output.bytes,
    mtimeMs: manifest.output.mtimeMs,
    ino: manifest.output.ino,
  });

/** What is at the canonical path right now, before a publish replaces it. */
export const captureExportBefore = (slug: string, presetId: RenderPresetId): ExportBeforePublish => {
  const output = trackOutputLocation(slug, presetId);
  let hadOutput = false;
  try {
    const stats = statSync(output.path);
    hadOutput = stats.isFile() && stats.size > 0;
  } catch {
    hadOutput = false;
  }
  return {
    hadOutput,
    previous: hadOutput ? readExportManifest(output.manifest, slug, presetId).manifest : null,
  };
};

const presetSnapshot = (presetId: RenderPresetId) => {
  const preset = renderPreset(presetId);
  return {
    id: preset.id,
    label: preset.shortLabel,
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
  };
};

const manifestLabel = (slug: string, presetId: string): string =>
  `out/${slug}/${presetId}.manifest.json`;

const sameExport = (record: ContentLibraryRecord, manifest: ExportManifest): boolean =>
  record.generatedAt === manifest.renderedAt &&
  record.manifest.inputFingerprint === manifest.inputFingerprint &&
  record.output.bytes === manifest.output.bytes &&
  record.output.mtimeMs === manifest.output.mtimeMs &&
  record.output.ino === manifest.output.ino;

const inputsOf = (manifest: ExportManifest): ExportInputs => manifest.inputs;

export type RecordPublishedExportInput = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  /** The track as it was rendered — from the props, never re-read afterwards. */
  readonly track: LibraryTrackSnapshot;
  readonly jobId: string | null;
  readonly before: ExportBeforePublish;
  readonly published: ExportManifest;
  readonly now?: () => Date;
  readonly root?: string;
};

/** Appends the record for an export that has just been published. Never throws. */
export const recordPublishedExport = (
  input: RecordPublishedExportInput,
): Promise<AppendContentLibraryResult> => {
  const { slug, presetId, track, jobId, before, published } = input;
  const now = input.now ?? (() => new Date());

  return appendContentLibraryRecord((existing) => {
    const previous = before.previous;
    // The newest record describing the export this one replaced. Matched on
    // the manifest's full identity, not on "latest for this format", so an
    // export that was replaced by an unrecorded render is never mislinked.
    const replacedRecord = previous
      ? [...existing].reverse().find(
          (record) =>
            record.track.slug === slug &&
            record.preset.id === presetId &&
            sameExport(record, previous),
        )
      : undefined;

    return {
      schemaVersion: CONTENT_LIBRARY_SCHEMA_VERSION,
      recordId: libraryRecordIdFor(slug, presetId, published),
      kind: "export",
      source: "render",
      generatedAt: published.renderedAt,
      recordedAt: now().toISOString(),
      track,
      preset: presetSnapshot(presetId),
      template: { composition: COMPOSITION_ID, visualizerVersion: VISUALIZER_VERSION },
      output: {
        path: outputLabel(slug, presetId),
        bytes: published.output.bytes,
        mtimeMs: published.output.mtimeMs,
        ino: published.output.ino,
      },
      manifest: {
        path: manifestLabel(slug, presetId),
        inputFingerprint: published.inputFingerprint,
        inputs: inputsOf(published),
      },
      renderJobId: jobId,
      exportKind: before.hadOutput ? "reexport" : "original",
      replaces: before.hadOutput
        ? {
            recordId: replacedRecord?.recordId ?? null,
            generatedAt: previous?.renderedAt ?? null,
            inputFingerprint: previous?.inputFingerprint ?? null,
            changed: previous ? compareInputs(inputsOf(previous), inputsOf(published)) : [],
          }
        : null,
    };
  }, input.root ?? contentLibraryRoot());
};

export type PublishRecordedExportInput = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly inputs: ExportInputs;
  readonly produce: (stagedVideo: string) => Promise<void>;
  readonly checkCancelled?: () => void;
  readonly lock?: RenderTargetLock;
  readonly track: LibraryTrackSnapshot;
  readonly jobId: string | null;
  readonly root?: string;
};

/**
 * `publishExport`, then a library record for what it published.
 *
 * Everything that decides the record happens inside the render target's lock.
 * If publishing throws (a failed or cancelled render), this throws the same
 * error and nothing is recorded.
 */
export const publishRecordedExport = async (
  input: PublishRecordedExportInput,
): Promise<AppendContentLibraryResult> => {
  if (!input.lock) {
    return withRenderTargetLock(input.slug, input.presetId, (owned) =>
      publishRecordedExport({ ...input, lock: owned }),
    );
  }

  const before = captureExportBefore(input.slug, input.presetId);
  await publishExport(
    input.slug,
    input.presetId,
    input.inputs,
    input.produce,
    input.checkCancelled,
    input.lock,
  );

  const output = trackOutputLocation(input.slug, input.presetId);
  const { manifest } = readExportManifest(output.manifest, input.slug, input.presetId);
  if (manifest === null) {
    // publishExport wrote this manifest moments ago under the lock we still
    // hold, so this is not expected — but it is reported rather than thrown:
    // the export itself is published and must not be disowned.
    return {
      appended: false,
      duplicate: false,
      record: null,
      problem: `The export was published but its manifest could not be read back, so it was not recorded in the content library.`,
    };
  }

  return recordPublishedExport({
    slug: input.slug,
    presetId: input.presetId,
    track: input.track,
    jobId: input.jobId,
    before,
    published: manifest,
    root: input.root,
  });
};

/* ------------------------------------------------------------------ *
 * Adopting exports rendered before the library existed
 * ------------------------------------------------------------------ */

export type AdoptExistingExportsResult = {
  /** Records appended by this run. */
  readonly adopted: number;
  /** Exports already in the library. */
  readonly alreadyRecorded: number;
  /** Exports on disk that could not be adopted, with why. */
  readonly skipped: readonly { readonly slug: string; readonly presetId: string; readonly reason: string }[];
  readonly problems: readonly string[];
};

/** Every track folder name that is a valid slug, without inspecting any of them. */
const trackDirectorySlugs = (): readonly string[] => {
  try {
    return readdirSync(TRACKS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidSlug(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
};

const trackFromMetadata = (slug: string, metadata: TrackMetadata): LibraryTrackSnapshot => ({
  slug,
  title: metadata.title,
  artist: metadata.artist,
  key: metadata.key,
  bpm: metadata.bpm,
  ...(metadata.subtitle ? { subtitle: metadata.subtitle } : {}),
});

/**
 * Records every export already on disk that the library does not know about.
 *
 * Only an export whose file still matches its own manifest is adopted — one
 * edited or replaced by hand since is skipped, because the manifest would no
 * longer describe it. Adopted records say so (`source: "adopted"`): the
 * generation time and identity are the manifest's real ones, but the job, the
 * kind and what it replaced are unknown, and the track snapshot is current
 * metadata. Idempotent — an export already recorded is never recorded again.
 */
export const adoptExistingExports = async (
  options: {
    readonly root?: string;
    readonly now?: () => Date;
    /** Only these tracks; every track folder when omitted. */
    readonly slugs?: readonly string[];
  } = {},
): Promise<AdoptExistingExportsResult> => {
  const now = options.now ?? (() => new Date());
  const root = options.root ?? contentLibraryRoot();
  let adopted = 0;
  let alreadyRecorded = 0;
  const skipped: { slug: string; presetId: string; reason: string }[] = [];
  const problems: string[] = [];

  for (const slug of options.slugs ?? trackDirectorySlugs()) {
    // One track at a time, so a folder removed mid-scan (or one that cannot be
    // read) is reported and skipped rather than failing the whole adoption.
    let metadata: TrackMetadata | null;
    try {
      metadata = (await inspectTrack(slug)).metadata;
    } catch (error) {
      problems.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (metadata === null) continue;

    let coverage: ReturnType<typeof trackExportCoverage>;
    try {
      coverage = trackExportCoverage(slug, metadata);
    } catch (error) {
      problems.push(`${slug}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    for (const preset of RENDER_PRESET_LIST) {
      const facts = coverage.find((entry) => entry.presetId === preset.id);
      if (!facts?.rendered) continue;

      const output = trackOutputLocation(slug, preset.id);
      const { manifest } = readExportManifest(output.manifest, slug, preset.id);
      if (manifest === null) {
        skipped.push({ slug, presetId: preset.id, reason: "no valid manifest" });
        continue;
      }
      if (facts.staleReasons.includes("output_changed")) {
        skipped.push({ slug, presetId: preset.id, reason: "the file no longer matches its manifest" });
        continue;
      }

      // Which visualizer produced it can only be vouched for when the export
      // is not stale on that axis; otherwise it is honestly unknown.
      const visualizerVersion =
        facts.freshness === "current" ||
        (facts.freshness === "stale" && !facts.staleReasons.includes("visualizer_changed"))
          ? VISUALIZER_VERSION
          : "unknown";

      const result = await appendContentLibraryRecord(
        () => ({
          schemaVersion: CONTENT_LIBRARY_SCHEMA_VERSION,
          recordId: libraryRecordIdFor(slug, preset.id, manifest),
          kind: "export",
          source: "adopted",
          generatedAt: manifest.renderedAt,
          recordedAt: now().toISOString(),
          track: trackFromMetadata(slug, metadata),
          preset: presetSnapshot(preset.id),
          template: { composition: COMPOSITION_ID, visualizerVersion },
          output: {
            path: outputLabel(slug, preset.id),
            bytes: manifest.output.bytes,
            mtimeMs: manifest.output.mtimeMs,
            ino: manifest.output.ino,
          },
          manifest: {
            path: manifestLabel(slug, preset.id),
            inputFingerprint: manifest.inputFingerprint,
            inputs: inputsOf(manifest),
          },
          renderJobId: null,
          exportKind: null,
          replaces: null,
        }),
        root,
      );

      if (result.appended) adopted += 1;
      else if (result.duplicate) alreadyRecorded += 1;
      else if (result.problem) problems.push(`${slug} ${preset.id}: ${result.problem}`);
    }
  }

  return { adopted, alreadyRecorded, skipped, problems };
};

/** The track snapshot a render records, taken from the props it rendered with. */
export const trackSnapshotFromProps = (
  slug: string,
  props: {
    readonly title: string;
    readonly artist: string;
    readonly musicalKey: string;
    readonly bpm: number;
    readonly subtitle?: string;
  },
): LibraryTrackSnapshot => ({
  slug,
  title: props.title,
  artist: props.artist,
  key: props.musicalKey,
  bpm: props.bpm,
  ...(props.subtitle ? { subtitle: props.subtitle } : {}),
});
