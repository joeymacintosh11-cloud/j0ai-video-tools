import { TrackError, trackIssue } from "../tracks/errors.ts";

/** Bump when composition/layout/fonts/encoding behaviour changes intentionally. */
export const VISUALIZER_VERSION = "toshi-1";
export const EXPORT_MANIFEST_VERSION = 1;
export type ExportMode = "missing" | "stale" | "missing-and-stale";
export type ExportFreshness = "missing" | "current" | "stale" | "invalid";
export type StaleReason =
  | "metadata_changed"
  | "cover_changed"
  | "audio_changed"
  | "preset_changed"
  | "visualizer_changed"
  | "template_changed"
  | "template_identity_missing"
  | "template_unavailable"
  | "manifest_missing"
  | "manifest_invalid"
  | "output_changed";

export const STALE_REASON_LABELS: Record<StaleReason, string> = {
  metadata_changed: "Metadata changed",
  cover_changed: "Cover changed",
  audio_changed: "Audio changed",
  preset_changed: "Format changed",
  visualizer_changed: "Visualizer or brand changed",
  template_changed: "Template changed",
  template_identity_missing: "Earlier export — template identity unknown; re-export required",
  template_unavailable: "Template unavailable — freshness unknown; check renderer settings",
  manifest_missing: "Earlier export — no manifest",
  manifest_invalid: "Manifest unreadable or incompatible",
  output_changed: "Output changed outside the renderer",
};

export const assertExportMode = (value: unknown): ExportMode => {
  if (value === undefined) return "missing";
  if (value === "missing" || value === "stale" || value === "missing-and-stale")
    return value;
  throw new TrackError(
    trackIssue(
      "INVALID_REQUEST",
      'mode must be "missing", "stale", or "missing-and-stale".',
    ),
  );
};
