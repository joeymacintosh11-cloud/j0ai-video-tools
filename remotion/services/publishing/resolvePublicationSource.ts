import type { PublishProblem } from "../../core/domain/publishing/publishProblems.ts";
import {
  sameSourceIdentity,
  type PublicationSourceIdentity,
  type PublicationSourceRef,
} from "../../core/domain/publishing/publicationSource.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { STALE_REASON_LABELS, type ExportFreshness, type StaleReason } from "../../core/domain/video/exportFreshness.ts";
import { RENDERER_LABELS } from "../../core/domain/video/renderers.ts";
import { trackExportCoverage } from "../tracks/exportCoverage.ts";
import { readExportManifest } from "../tracks/exportManifest.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { trackLocations, trackOutputLocation } from "../tracks/trackLocations.ts";

/**
 * Finds the exact export a publication refers to, on disk, now.
 *
 * Reads the named renderer's export only (trackOutputLocation with that
 * renderer): Remotion's out/<slug>/<preset>.mp4 or another engine's
 * out/<slug>/<renderer>/<preset>.mp4. There is no fallback to any other
 * renderer's export or any other format; a missing or stale export is a
 * problem reported as such. The track's saved renderer *preference* is not
 * consulted — the reference names the renderer explicitly.
 *
 * Freshness is the same coverage every other workflow uses, so an export that
 * delivery or a content package would call stale is stale here too.
 */

export type ResolvedPublicationSource = {
  readonly ref: PublicationSourceRef;
  /** Pinned identity when the export exists and is current; null otherwise. */
  readonly identity: PublicationSourceIdentity | null;
  readonly freshness: ExportFreshness;
  readonly staleReasons: readonly StaleReason[];
  readonly outputLabel: string;
  readonly problems: readonly PublishProblem[];
  /** Absolute paths for the engine only; never sent to clients or written to records. */
  readonly file: string;
  readonly coverFile: string;
};

export const resolvePublicationSource = async (
  ref: PublicationSourceRef,
): Promise<ResolvedPublicationSource> => {
  const inspection = await inspectTrack(ref.slug);
  if (!inspection.facts.trackDirExists)
    throw new TrackError(trackIssue("TRACK_NOT_FOUND", `Track "${ref.slug}" not found.`, `public/tracks/${ref.slug}/`));

  const output = trackOutputLocation(ref.slug, ref.presetId, ref.renderer);
  const base = { ref, file: output.path, coverFile: trackLocations(ref.slug).cover, outputLabel: output.label };
  const renderer = RENDERER_LABELS[ref.renderer];

  if (inspection.metadata === null) {
    return {
      ...base, identity: null, freshness: "invalid", staleReasons: [],
      problems: [{ reason: "track_invalid", message: `Track "${ref.slug}" has invalid metadata, so its exports cannot be checked.` }],
    };
  }

  const facts = trackExportCoverage(ref.slug, inspection.metadata, ref.renderer).find((entry) => entry.presetId === ref.presetId)!;

  if (!facts.rendered) {
    return {
      ...base, identity: null, freshness: "missing", staleReasons: [],
      problems: [{ reason: "export_missing", message: `There is no ${renderer} ${facts.label} export (${output.label}). Render it first; another renderer's export is never used instead.` }],
    };
  }

  if (facts.freshness !== "current" || facts.outputIdentity === undefined || facts.inputFingerprint === null) {
    const reasons = facts.staleReasons.map((reason) => STALE_REASON_LABELS[reason]).join(", ");
    return {
      ...base, identity: null, freshness: facts.freshness, staleReasons: facts.staleReasons,
      problems: [{ reason: "export_stale", message: `The ${renderer} ${facts.label} export (${output.label}) is ${facts.freshness}${reasons ? `: ${reasons}` : ""}. Re-render it before publishing.` }],
    };
  }

  const { manifest } = readExportManifest(output.manifest, ref.slug, ref.presetId);
  if (manifest === null || manifest.inputFingerprint !== facts.inputFingerprint) {
    return {
      ...base, identity: null, freshness: "stale", staleReasons: ["manifest_invalid"],
      problems: [{ reason: "export_stale", message: `The ${renderer} ${facts.label} export changed while it was being checked. Try again.` }],
    };
  }

  return {
    ...base,
    freshness: "current",
    staleReasons: [],
    problems: [],
    identity: {
      ...ref,
      inputFingerprint: manifest.inputFingerprint,
      renderedAt: manifest.renderedAt,
      output: facts.outputIdentity,
      outputLabel: output.label,
    },
  };
};

/** The pinned identity is still exactly what is on disk; otherwise a source_changed (or stale/missing) problem. */
export const pinnedSourceProblems = (
  resolved: ResolvedPublicationSource,
  pinned: PublicationSourceIdentity,
): readonly PublishProblem[] => {
  if (resolved.identity === null) return resolved.problems;
  return sameSourceIdentity(resolved.identity, pinned)
    ? []
    : [{ reason: "source_changed", message: `${pinned.outputLabel} was re-rendered or replaced after this job was created. Create a new publish job for the new export.` }];
};
