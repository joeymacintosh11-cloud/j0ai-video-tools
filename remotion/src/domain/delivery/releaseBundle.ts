import type { DeliveryReason } from "./deliveryPaths.ts";
import type { RenderPresetId } from "../video/renderPresets.ts";

/**
 * What a delivered track says about itself.
 *
 * A release bundle is two small files written beside the delivered videos:
 * `release.json` for anything that reads it, and `release.md` for anyone who
 * opens the folder. Together they answer one question — what shipped, in which
 * formats, when, and what is still missing.
 *
 * Pure and browser-safe, so the schema and the Markdown rendering live in one
 * place and the server, the CLI and the UI all describe a bundle identically.
 * Nothing here knows an absolute path: a bundle travels with the folder it
 * sits in, so it records the folder's own name and the filenames beside it,
 * never the machine-local root they happen to live under today.
 */

export const RELEASE_BUNDLE_SCHEMA_VERSION = 1;
export const RELEASE_JSON_FILENAME = "release.json";
/**
 * How much of the bundle id the Markdown carries.
 *
 * A 64-character hash in a document meant for people is noise; 48 bits is
 * ample for spotting a pair whose two halves disagree.
 */
export const SHORT_BUNDLE_ID_LENGTH = 12;
export const shortBundleId = (bundleId: string): string =>
  bundleId.slice(0, SHORT_BUNDLE_ID_LENGTH);
export const RELEASE_MARKDOWN_FILENAME = "release.md";

/**
 * - not_configured: no destination, so there is nowhere for a bundle
 * - missing:        no readable bundle in the track's folder
 * - outdated:       a bundle is there, but no longer describes what is
 * - current:        the bundle matches the delivery state on disk
 */
export type ReleaseBundleFreshness =
  | "not_configured"
  | "missing"
  | "outdated"
  | "current";

/**
 * One intended format's place in a release.
 *
 * `delivered` means a copy is at the destination *and* it is of the current
 * canonical export. Anything else is `outdated` (a copy is there but does not
 * represent what should ship) or `missing` (nothing is there). Those three are
 * kept apart everywhere, because "we shipped this" and "there is a file" are
 * different claims.
 */
export type ReleaseFormatStatus = "delivered" | "outdated" | "missing";

export type ReleaseFormatEntry = {
  readonly presetId: RenderPresetId;
  /** Short preset label, e.g. "Reels 9:16". */
  readonly label: string;
  /** Name of the file in this folder. Present even when nothing is there yet. */
  readonly filename: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
  readonly status: ReleaseFormatStatus;
  /** Why this format is not delivered; null when it is. */
  readonly reason: DeliveryReason | null;
  /** Rendered length, or null when the source audio could not be read. */
  readonly durationSeconds: number | null;
  readonly durationFrames: number | null;
  /**
   * Size of the delivered copy. Null unless the copy is confirmed delivered —
   * for anything else the recorded size may describe a file that has since been
   * replaced, and a wrong number is worse than none.
   */
  readonly bytes: number | null;
  readonly deliveredAt: string | null;
  /** The canonical export's input fingerprint, for tracing what was shipped. */
  readonly exportFingerprint: string | null;
};

export type ReleaseBundleTrack = {
  readonly slug: string;
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: number;
  readonly subtitle?: string;
};

export type ReleaseBundle = {
  readonly schemaVersion: number;
  /**
   * Fingerprint of the delivery state this bundle describes. Shared by both
   * files, so a half-updated pair is detectable, and compared against the
   * current state to decide whether the bundle is still accurate.
   */
  readonly bundleId: string;
  readonly generatedAt: string;
  readonly track: ReleaseBundleTrack;
  /** This folder's own name, not a path. A bundle travels with its folder. */
  readonly folder: string;
  readonly intendedPresets: readonly RenderPresetId[];
  /** Delivered and current, in canonical preset order. */
  readonly deliveries: readonly ReleaseFormatEntry[];
  /** A copy is present but does not represent what should ship. */
  readonly outdated: readonly ReleaseFormatEntry[];
  /** Intended, with nothing at the destination. */
  readonly missing: readonly ReleaseFormatEntry[];
};

/** Everything the bundle fingerprint is derived from, in a fixed order. */
export type ReleaseBundleFingerprintInput = {
  readonly schemaVersion: number;
  readonly slug: string;
  readonly folder: string;
  readonly track: ReleaseBundleTrack;
  readonly intendedPresets: readonly RenderPresetId[];
  readonly formats: readonly {
    readonly presetId: RenderPresetId;
    readonly status: ReleaseFormatStatus;
    readonly reason: DeliveryReason | null;
    readonly exportFingerprint: string | null;
    readonly deliveredAt: string | null;
    readonly deliveredBytes: number | null;
    /** The exact canonical file a delivery was made from. */
    readonly sourceOutput: string | null;
  }[];
};

/**
 * The stable text a fingerprint is taken over.
 *
 * Deliberately not the bundle itself: `generatedAt` changes on every run, so
 * hashing the document would make a bundle instantly outdated. Only facts about
 * what shipped go in here — and no timestamps that move on their own.
 */
export const releaseBundleFingerprintText = (
  input: ReleaseBundleFingerprintInput,
): string =>
  JSON.stringify([
    input.schemaVersion,
    input.slug,
    input.folder,
    [
      input.track.title,
      input.track.artist,
      input.track.key,
      input.track.bpm,
      input.track.subtitle ?? "",
    ],
    [...input.intendedPresets],
    input.formats.map((format) => [
      format.presetId,
      format.status,
      format.reason ?? "",
      format.exportFingerprint ?? "",
      format.deliveredAt ?? "",
      format.deliveredBytes ?? -1,
      format.sourceOutput ?? "",
    ]),
  ]);

/* ------------------------------------------------------------------ *
 * Human-readable rendering
 * ------------------------------------------------------------------ */

/** Decimal megabytes, which is what Finder shows. */
export const formatBytes = (bytes: number | null): string =>
  bytes === null ? "—" : `${(bytes / 1_000_000).toFixed(1)} MB`;

/** m:ss, which is how anyone reads a track length. */
export const formatDuration = (seconds: number | null): string => {
  if (seconds === null) return "—";

  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);

  return `${minutes}:${String(whole % 60).padStart(2, "0")}`;
};

/** "2026-09-18 19:42" in the bundle's own local time, without a timezone tail. */
export const formatBundleTimestamp = (iso: string): string => {
  const parsed = new Date(iso);

  if (Number.isNaN(parsed.getTime())) return iso;

  const pad = (value: number) => String(value).padStart(2, "0");

  return (
    `${parsed.getFullYear()}-${pad(parsed.getMonth() + 1)}-${pad(parsed.getDate())}` +
    ` ${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`
  );
};

const REASON_NOTES: Partial<Record<DeliveryReason, string>> = {
  export_changed: "re-rendered since it was delivered",
  export_not_current: "export is out of date — re-render it",
  export_missing: "not rendered yet",
  never_delivered: "not delivered yet",
  destination_changed: "delivered somewhere else",
  destination_missing: "the delivered file is gone",
  destination_modified: "the delivered file was changed here",
};

const formatLine = (entry: ReleaseFormatEntry): string => {
  const note = entry.reason ? REASON_NOTES[entry.reason] : undefined;

  if (entry.status === "delivered") {
    return (
      `- ${entry.label} — ${entry.width}×${entry.height} — ` +
      `${formatDuration(entry.durationSeconds)} — ${formatBytes(entry.bytes)}`
    );
  }

  return `- ${entry.label}${note ? ` — ${note}` : ""}`;
};

/**
 * The Markdown a person reads when they open the folder.
 *
 * Fixed section order and fixed formatting, so the same delivery state always
 * produces the same document. Sections with nothing in them are left out
 * entirely rather than printed empty — a release that shipped everything should
 * not have a "Missing" heading.
 */
export const renderReleaseMarkdown = (bundle: ReleaseBundle): string => {
  const lines: string[] = [`# ${bundle.track.title} — ${bundle.track.artist}`, ""];

  lines.push(`Key: ${bundle.track.key}`, `BPM: ${bundle.track.bpm}`);
  if (bundle.track.subtitle) lines.push("", bundle.track.subtitle);

  const section = (heading: string, entries: readonly ReleaseFormatEntry[]) => {
    if (entries.length === 0) return;
    lines.push("", `## ${heading}`, "");
    for (const entry of entries) lines.push(formatLine(entry));
  };

  section("Delivered", bundle.deliveries);
  section("Outdated", bundle.outdated);
  section("Missing", bundle.missing);

  if (bundle.deliveries.length === 0) {
    lines.push("", "Nothing has been delivered yet.");
  }

  lines.push(
    "",
    "---",
    "",
    `Generated ${formatBundleTimestamp(bundle.generatedAt)} · bundle \`${shortBundleId(bundle.bundleId)}\``,
    "",
  );

  return lines.join("\n");
};

/**
 * The shortened bundle id recorded in the Markdown, or null.
 *
 * Read back so a half-updated pair is detectable: the two files cannot be
 * renamed into place in one step, so the only guard is that both carry the same
 * id and the JSON is published last. Compare it against shortBundleId().
 */
export const readMarkdownBundleId = (markdown: string): string | null =>
  /bundle `([0-9a-f]{6,64})`/.exec(markdown)?.[1] ?? null;
