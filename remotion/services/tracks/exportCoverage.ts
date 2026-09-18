import { statSync } from "node:fs";
import {
  RENDER_PRESET_LIST,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import { trackOutputLocation } from "./trackLocations.ts";

/**
 * What a track has actually exported, read from disk.
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
): ExportFileFacts => {
  const output = trackOutputLocation(slug, presetId);

  // statSync throws for a missing file; anything else (a permission error, say)
  // is treated the same way — we cannot see an export, so there isn't one.
  let bytes: number | null = null;
  let modifiedAt: string | null = null;

  try {
    const stats = statSync(output.path);
    bytes = stats.size;
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

/** Every format's export state for one track, in preset order. */
export const trackExportCoverage = (
  slug: string,
): readonly ExportFileFacts[] =>
  RENDER_PRESET_LIST.map((preset) =>
    fileFacts(slug, preset.id, preset.shortLabel),
  );

/** Just the formats that have a usable export on disk. */
export const renderedPresetIds = (slug: string): readonly RenderPresetId[] =>
  trackExportCoverage(slug)
    .filter((facts) => facts.rendered)
    .map((facts) => facts.presetId);
