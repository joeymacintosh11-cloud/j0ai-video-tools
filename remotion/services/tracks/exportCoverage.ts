import { readFileSync, statSync } from "node:fs";
import { parseTrackMetadata } from "../../src/domain/tracks/metadata.ts";
import type { TrackMetadata } from "../../src/domain/tracks/types.ts";
import type {
  ExportFreshness,
  StaleReason,
} from "../../src/domain/video/exportFreshness.ts";
import { buildTrackProps } from "./buildTrackProps.ts";
import {
  compareInputs,
  fingerprintInputs,
  outputIdentity,
  readExportManifest,
} from "./exportManifest.ts";
import {
  RENDER_PRESET_LIST,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import { trackLocations, trackOutputLocation } from "./trackLocations.ts";

/**
 * Export presence and input freshness, read from disk and sidecar manifests.
 *
 * The filesystem is the source of truth for finished renders — not the job
 * history, which lives in memory and is forgotten on restart. Everything that
 * needs to know whether an export exists reads it through here, so the UI, the
 * API and the export planner cannot drift apart.
 *
 * The health check is deliberately shallow: a file that exists but is empty is
 * the tell-tale of an interrupted or failed write, and is reported as not
 * rendered so it will be produced again. Anything deeper — decoding the file,
 * checking its duration or dimensions — would mean opening every MP4 on every
 * listing, which is far too expensive for browsing. See §35 of the handoff.
 */

export type ExportFileFacts = {
  readonly freshness: ExportFreshness;
  readonly staleReasons: readonly StaleReason[];
  /**
   * The manifest's input fingerprint, or null without a valid manifest. Read
   * here because coverage already opens the manifest; delivery compares its
   * receipt against this rather than reading the manifest a second time.
   */
  readonly inputFingerprint: string | null;
  readonly presetId: RenderPresetId;
  /** Short preset label, e.g. "Reels 9:16". */
  readonly label: string;
  /** "out/<slug>/<preset>.mp4", for messages. */
  readonly outputLabel: string;
  /** Absolute path, present whether or not the file exists yet. */
  readonly outputPath: string;
  /** The file exists and is non-empty. */
  readonly rendered: boolean;
  readonly bytes: number | null;
  readonly modifiedAt: string | null;
  /** The file exists but has zero bytes — a broken leftover, not an export. */
  readonly empty: boolean;
};

const fileFacts = (
  slug: string,
  presetId: RenderPresetId,
  label: string,
): Omit<ExportFileFacts, "freshness" | "staleReasons" | "inputFingerprint"> => {
  const output = trackOutputLocation(slug, presetId);

  // statSync throws for a missing file; anything else (a permission error, say)
  // is treated the same way — we cannot see an export, so there isn't one.
  let bytes: number | null = null;
  let modifiedAt: string | null = null;

  try {
    const stats = statSync(output.path);
    bytes = stats.isFile() ? stats.size : null;
    modifiedAt = new Date(stats.mtimeMs).toISOString();
  } catch {
    bytes = null;
  }

  return {
    presetId,
    label,
    outputLabel: output.label,
    outputPath: output.path,
    rendered: bytes !== null && bytes > 0,
    bytes,
    modifiedAt,
    empty: bytes === 0,
  };
};

/** Filesystem coverage plus freshness, with queue state deliberately separate. */
export const trackExportCoverage = (
  slug: string,
  metadata?: TrackMetadata | null,
): readonly ExportFileFacts[] => {
  if (metadata === undefined) {
    try {
      metadata = parseTrackMetadata(
        JSON.parse(readFileSync(trackLocations(slug).metadata, "utf8")),
        "metadata.json",
      );
    } catch {
      metadata = null;
    }
  }
  return RENDER_PRESET_LIST.map((preset) => {
    const facts = fileFacts(slug, preset.id, preset.shortLabel);
    if (!facts.rendered)
      return {
        ...facts,
        freshness: "missing",
        staleReasons: [],
        inputFingerprint: null,
      };
    const output = trackOutputLocation(slug, preset.id);
    const { manifest, reason } = readExportManifest(
      output.manifest,
      slug,
      preset.id,
    );
    if (!manifest)
      return {
        ...facts,
        freshness: "stale",
        staleReasons: [reason!],
        inputFingerprint: null,
      };
    if (!metadata)
      return {
        ...facts,
        freshness: "invalid",
        staleReasons: [],
        inputFingerprint: manifest.inputFingerprint,
      };
    try {
      const current = fingerprintInputs(
        buildTrackProps({ slug, metadata, analysisAvailable: true }),
        preset.id,
      );
      const staleReasons = compareInputs(manifest.inputs, current);
      const identity = outputIdentity(output.path);
      if (
        identity.bytes !== manifest.output.bytes ||
        identity.mtimeMs !== manifest.output.mtimeMs ||
        identity.ino !== manifest.output.ino
      ) {
        staleReasons.push("output_changed");
      }
      return {
        ...facts,
        freshness: staleReasons.length ? "stale" : "current",
        staleReasons,
        inputFingerprint: manifest.inputFingerprint,
      };
    } catch {
      // Missing/unreadable inputs cannot establish freshness; validation reports why.
      return {
        ...facts,
        freshness: "invalid",
        staleReasons: [],
        inputFingerprint: manifest.inputFingerprint,
      };
    }
  });
};

/** Cheap presence-only observation for validation; freshness is read by views/plans. */
export const renderedPresetIds = (slug: string): readonly RenderPresetId[] =>
  RENDER_PRESET_LIST.filter(
    (preset) => fileFacts(slug, preset.id, preset.shortLabel).rendered,
  ).map((preset) => preset.id);
