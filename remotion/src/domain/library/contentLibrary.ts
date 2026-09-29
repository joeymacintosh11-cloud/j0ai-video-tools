import { parseRelativePeriod, type DeliveryLogEvent } from "../delivery/deliveryHistory.ts";
import { TrackError, trackIssue } from "../tracks/errors.ts";
import { isValidSlug } from "../tracks/slug.ts";
import {
  STALE_REASON_LABELS,
  type ExportFreshness,
  type StaleReason,
} from "../video/exportFreshness.ts";

/**
 * The content library: an append-only record of every export this project has
 * generated, for every track, over time.
 *
 * Three histories now exist, and each answers a different question:
 *
 * - the render journal (src/domain/render/renderJournal.ts) — "what happened
 *   to render job X?" Lifecycle only, failures and cancellations included,
 *   bounded by retention and compaction, and deliberately free of content
 *   facts;
 * - the delivery log (src/domain/delivery/deliveryHistory.ts) — "what went out
 *   to this destination, and when?" It lives *at* a destination, so it only
 *   exists once one is configured;
 * - this library — "what content has been generated for this track, and which
 *   version is the one on disk now?" Project-local, permanent, and independent
 *   of any destination.
 *
 * A record is written only for a genuinely completed export: after the render
 * target's atomic publish has succeeded (services/library/recordExport.ts). A
 * failed, cancelled or validation-rejected render never reaches that point, so
 * this file never holds an attempt dressed up as a result — those stay in the
 * render journal, which is where the lifecycle of an attempt belongs.
 *
 * Pure and browser-safe, like the delivery log's own domain module: the record
 * shape, parsing, derived status and querying live here so the API, the CLI
 * and the UI agree on them without any I/O.
 */

export const CONTENT_LIBRARY_SCHEMA_VERSION = 1;
export const CONTENT_LIBRARY_FILENAME = "library.jsonl";

/** How many entries a query returns when the caller does not say. */
export const CONTENT_LIBRARY_DEFAULT_LIMIT = 50;
/** Hard ceiling, so no request can ask for an unbounded response. */
export const CONTENT_LIBRARY_MAX_LIMIT = 500;

/** A record id is a truncated sha256 of the published export's identity. */
export const CONTENT_LIBRARY_RECORD_ID_PATTERN = /^[a-f0-9]{32}$/;

/**
 * How a record came to be written.
 *
 * - `render`:  appended by the render that produced the export, from the
 *              props it actually rendered with.
 * - `adopted`: reconstructed later from an export that was already on disk
 *              (one rendered before the library existed). Its generation time
 *              and identity are the manifest's real ones, but its track
 *              snapshot is *current* metadata, and nothing is known about the
 *              job or about what it replaced. Marked so a reader is never
 *              misled — the same distinction the delivery log draws with
 *              `reconciled`.
 */
export type ContentLibrarySource = "render" | "adopted";

/**
 * - original: nothing was published at this track/format's canonical path
 *             before this export.
 * - reexport: this export replaced one that was already there.
 */
export type ExportKind = "original" | "reexport";

export type LibraryTrackSnapshot = {
  readonly slug: string;
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: number;
  readonly subtitle?: string;
};

/**
 * The format as it was defined when this was generated — recorded in full
 * rather than by id, so retiring or redefining a preset never changes what
 * history says was produced. `id` is a plain string for the same reason.
 */
export type LibraryPresetSnapshot = {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
};

/** Which composition, at which visual version, produced this. */
export type LibraryTemplate = {
  readonly composition: string;
  readonly visualizerVersion: string;
};

export type LibraryInputs = Readonly<
  Record<"metadata" | "cover" | "audio" | "preset" | "visualizer", string>
>;

/**
 * What a re-export replaced.
 *
 * Captured under the render target's lock at publish time, from the manifest
 * that was on disk immediately before — so it names what was *actually*
 * replaced, whatever triggered the render (the Content Package's Build, a
 * batch, the CLI, or a re-export started from this library).
 */
export type LibraryReplacement = {
  /** The library record of the replaced export; null if it predates the library. */
  readonly recordId: string | null;
  /** Null when the replaced file had no valid manifest. */
  readonly generatedAt: string | null;
  readonly inputFingerprint: string | null;
  /** Which inputs differ from the replaced version; empty for a like-for-like re-render. */
  readonly changed: readonly StaleReason[];
};

export type ContentLibraryRecord = {
  readonly schemaVersion: number;
  /** Stable identity of one published export; an accidental second append of it is a duplicate. */
  readonly recordId: string;
  readonly kind: "export";
  readonly source: ContentLibrarySource;
  /** When the export was published — its manifest's own `renderedAt`. */
  readonly generatedAt: string;
  /** When this line was appended. */
  readonly recordedAt: string;
  readonly track: LibraryTrackSnapshot;
  readonly preset: LibraryPresetSnapshot;
  readonly template: LibraryTemplate;
  /**
   * Portable, project-relative (`out/<slug>/<preset>.mp4`). The file itself is
   * replaced by the next export of the same track and format, so the identity
   * below — not the path — is what says whether it still holds this version.
   */
  readonly output: {
    readonly path: string;
    readonly bytes: number;
    readonly mtimeMs: number;
    readonly ino: number;
  };
  /**
   * The manifest's identifying facts. Copied rather than referenced because
   * the manifest file is overwritten by the next export; `inputs` is what lets
   * any two versions be compared ("re-exported because the cover changed").
   */
  readonly manifest: {
    readonly path: string;
    readonly inputFingerprint: string;
    readonly inputs: LibraryInputs;
  };
  /** Null for a CLI render (no job) and for an adopted record. */
  readonly renderJobId: string | null;
  /** Null only for an adopted record, where it cannot be known. */
  readonly exportKind: ExportKind | null;
  readonly replaces: LibraryReplacement | null;
};

/**
 * The text a record's id is hashed from — every fact that makes one published
 * export distinct from the next. Hashed by the service layer, because hashing
 * is not browser-safe.
 */
export type LibraryRecordIdentity = {
  readonly slug: string;
  readonly presetId: string;
  readonly generatedAt: string;
  readonly inputFingerprint: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly ino: number;
};

export const libraryRecordIdText = (identity: LibraryRecordIdentity): string =>
  JSON.stringify([
    identity.slug,
    identity.presetId,
    identity.generatedAt,
    identity.inputFingerprint,
    identity.bytes,
    identity.mtimeMs,
    identity.ino,
  ]);

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/** Same vocabulary, and the same meanings, as the delivery log's. */
export type ContentLibraryProblemKind = "malformed" | "unsupported" | "truncated" | "duplicate";

export type ContentLibraryProblem = {
  /** 1-based, so it matches what an editor shows. */
  readonly line: number;
  readonly kind: ContentLibraryProblemKind;
  readonly message: string;
};

export type ContentLibraryStatus =
  | "missing"
  | "complete"
  | "recovered_tail"
  | "unsupported"
  | "duplicated"
  | "corrupt";

export type ContentLibraryRead = {
  readonly status: ContentLibraryStatus;
  /** Every record that parsed, in the order it was appended. */
  readonly records: readonly ContentLibraryRecord[];
  readonly problems: readonly ContentLibraryProblem[];
  readonly lines: number;
  /** Whether the last line is terminated; an appender must know this. */
  readonly endsWithNewline: boolean;
};

export type ParsedContentLibraryLine =
  | { readonly ok: true; readonly record: ContentLibraryRecord }
  | {
      readonly ok: false;
      readonly kind: Exclude<ContentLibraryProblemKind, "truncated" | "duplicate">;
      readonly message: string;
    };

const HEX_64 = /^[a-f0-9]{64}$/;
const INPUT_KEYS = ["metadata", "cover", "audio", "preset", "visualizer"] as const;

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;
const isInstant = (value: unknown): value is string =>
  typeof value === "string" && !Number.isNaN(Date.parse(value));
const isKnownReason = (value: unknown): value is StaleReason =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(STALE_REASON_LABELS, value);

const validTrack = (value: unknown): boolean => {
  const track = value as LibraryTrackSnapshot | undefined;
  return (
    typeof track === "object" &&
    track !== null &&
    isNonEmptyString(track.slug) &&
    typeof track.title === "string" &&
    typeof track.artist === "string" &&
    typeof track.key === "string" &&
    Number.isFinite(track.bpm) &&
    (track.subtitle === undefined || typeof track.subtitle === "string")
  );
};

const validPreset = (value: unknown): boolean => {
  const preset = value as LibraryPresetSnapshot | undefined;
  return (
    typeof preset === "object" &&
    preset !== null &&
    isNonEmptyString(preset.id) &&
    typeof preset.label === "string" &&
    Number.isInteger(preset.width) &&
    Number.isInteger(preset.height) &&
    Number.isFinite(preset.fps)
  );
};

const validOutput = (value: unknown): boolean => {
  const output = value as ContentLibraryRecord["output"] | undefined;
  return (
    typeof output === "object" &&
    output !== null &&
    isNonEmptyString(output.path) &&
    Number.isFinite(output.bytes) &&
    output.bytes > 0 &&
    Number.isFinite(output.mtimeMs) &&
    Number.isFinite(output.ino)
  );
};

const validManifest = (value: unknown): boolean => {
  const manifest = value as ContentLibraryRecord["manifest"] | undefined;
  return (
    typeof manifest === "object" &&
    manifest !== null &&
    isNonEmptyString(manifest.path) &&
    HEX_64.test(String(manifest.inputFingerprint)) &&
    typeof manifest.inputs === "object" &&
    manifest.inputs !== null &&
    INPUT_KEYS.every((key) => HEX_64.test(String(manifest.inputs[key])))
  );
};

const validReplacement = (value: unknown): boolean => {
  if (value === null) return true;
  const replaces = value as LibraryReplacement | undefined;
  return (
    typeof replaces === "object" &&
    replaces !== null &&
    (replaces.recordId === null ||
      CONTENT_LIBRARY_RECORD_ID_PATTERN.test(String(replaces.recordId))) &&
    (replaces.generatedAt === null || isInstant(replaces.generatedAt)) &&
    (replaces.inputFingerprint === null || HEX_64.test(String(replaces.inputFingerprint))) &&
    Array.isArray(replaces.changed) &&
    replaces.changed.every(isKnownReason)
  );
};

/**
 * One line of the library, validated.
 *
 * A future schema version is `unsupported` rather than damage: the line is
 * well-formed, this version simply does not know it, and saying so is what
 * stops a newer library being treated as corrupt.
 */
export const parseContentLibraryLine = (line: string): ParsedContentLibraryLine => {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, kind: "malformed", message: "not valid JSON" };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, kind: "malformed", message: "not a JSON object" };
  }

  const record = value as Partial<ContentLibraryRecord>;

  if (!Number.isInteger(record.schemaVersion) || (record.schemaVersion ?? 0) < 1) {
    return { ok: false, kind: "malformed", message: "no usable schemaVersion" };
  }

  if ((record.schemaVersion as number) > CONTENT_LIBRARY_SCHEMA_VERSION) {
    return {
      ok: false,
      kind: "unsupported",
      message:
        `schemaVersion ${record.schemaVersion} was written by a newer version of ` +
        `this tool (this one reads ${CONTENT_LIBRARY_SCHEMA_VERSION})`,
    };
  }

  if (record.kind !== "export") {
    return { ok: false, kind: "malformed", message: `unknown kind "${String(record.kind)}"` };
  }

  const kindConsistent =
    record.source === "adopted"
      ? record.exportKind === null && record.replaces === null
      : record.source === "render" &&
        (record.exportKind === "original"
          ? record.replaces === null
          : record.exportKind === "reexport" && record.replaces !== null);

  if (
    !CONTENT_LIBRARY_RECORD_ID_PATTERN.test(String(record.recordId)) ||
    !isInstant(record.generatedAt) ||
    !isInstant(record.recordedAt) ||
    !validTrack(record.track) ||
    !validPreset(record.preset) ||
    typeof record.template !== "object" ||
    record.template === null ||
    !isNonEmptyString(record.template.composition) ||
    !isNonEmptyString(record.template.visualizerVersion) ||
    !validOutput(record.output) ||
    !validManifest(record.manifest) ||
    (record.renderJobId !== null && !isNonEmptyString(record.renderJobId)) ||
    !validReplacement(record.replaces) ||
    !kindConsistent
  ) {
    return { ok: false, kind: "malformed", message: "not a well-formed export record" };
  }

  return { ok: true, record: record as ContentLibraryRecord };
};

/**
 * Parses the whole library from its text.
 *
 * A final line with no newline is an interrupted append — recoverable, and
 * expected after a hard crash. Damage anywhere else is reported as corruption,
 * and never hides the records around it: every valid line is still returned.
 */
export const parseContentLibrary = (text: string): ContentLibraryRead => {
  const records: ContentLibraryRecord[] = [];
  const problems: ContentLibraryProblem[] = [];
  const endsWithNewline = text.length === 0 || text.endsWith("\n");
  const rows = text.split("\n");

  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();

  const seen = new Set<string>();

  rows.forEach((row, index) => {
    const line = index + 1;
    const isFinal = index === rows.length - 1;

    if (row.trim().length === 0) return;

    const parsed = parseContentLibraryLine(row);

    if (!parsed.ok) {
      problems.push({
        line,
        kind: isFinal && !endsWithNewline && parsed.kind === "malformed" ? "truncated" : parsed.kind,
        message: parsed.message,
      });
      return;
    }

    // Nothing this tool writes can repeat a record: an append checks for one
    // under the same lock it writes under. A repeat means the file was edited
    // or merged — reported, but never allowed to count twice.
    if (seen.has(parsed.record.recordId)) {
      problems.push({
        line,
        kind: "duplicate",
        message: `repeats record ${parsed.record.recordId}`,
      });
      return;
    }

    seen.add(parsed.record.recordId);
    records.push(parsed.record);
  });

  const status: ContentLibraryStatus = problems.some((p) => p.kind === "malformed")
    ? "corrupt"
    : problems.some((p) => p.kind === "unsupported")
      ? "unsupported"
      : problems.some((p) => p.kind === "truncated")
        ? "recovered_tail"
        : problems.some((p) => p.kind === "duplicate")
          ? "duplicated"
          : "complete";

  return { status, records, problems, lines: rows.length, endsWithNewline };
};

export const CONTENT_LIBRARY_STATUS_NOTES: Record<ContentLibraryStatus, string | null> = {
  missing: null,
  complete: null,
  duplicated:
    "The content library contains a record more than once. Nothing this tool does " +
    "produces a repeat, so the file has been edited or merged. Each record is shown once " +
    "and nothing has been changed.",
  recovered_tail:
    "The last line of the content library is incomplete, which is what an interrupted " +
    "append leaves behind. Every record before it was read. Run " +
    "`npm run content-library -- --repair-tail` to drop the fragment.",
  unsupported:
    "The content library contains records written by a newer version of this tool. " +
    "Earlier records were read; nothing was changed.",
  corrupt:
    "The content library is damaged somewhere other than its last line, which a crash " +
    "cannot cause. The records that could be read are shown. Nothing has been rewritten — " +
    "inspect the file before repairing it.",
};

/* ------------------------------------------------------------------ *
 * Derived status — never persisted
 * ------------------------------------------------------------------ */

/**
 * - current:    this version is the file on disk now, and it is up to date
 *               with the track's current inputs.
 * - stale:      this version is still the file on disk, but it is no longer
 *               confirmed up to date (the track changed, or can't be checked).
 * - superseded: a later export of the same track and format replaced it.
 * - missing:    it is not on disk, and nothing later replaced it.
 *
 * Derived at read time from the live manifest, so history itself is never
 * rewritten to say a version went out of date.
 */
export type LibraryEntryStatus = "current" | "stale" | "superseded" | "missing";

export const LIBRARY_ENTRY_STATUSES: readonly LibraryEntryStatus[] = [
  "current",
  "stale",
  "superseded",
  "missing",
];

export const LIBRARY_ENTRY_STATUS_LABELS: Record<LibraryEntryStatus, string> = {
  current: "Current",
  stale: "Stale",
  superseded: "Superseded",
  missing: "Missing",
};

export const EXPORT_KIND_LABELS: Record<ExportKind, string> = {
  original: "Original",
  reexport: "Re-export",
};

/** What is at a track/format's canonical path right now. */
export type LiveExportFacts = {
  /** The manifest there, if valid. */
  readonly manifest: {
    readonly generatedAt: string;
    readonly inputFingerprint: string;
    readonly output: { readonly bytes: number; readonly mtimeMs: number; readonly ino: number };
  } | null;
  readonly freshness: ExportFreshness;
};

export const libraryTargetKey = (slug: string, presetId: string): string => `${slug}|${presetId}`;

const holdsThisVersion = (record: ContentLibraryRecord, live: LiveExportFacts | undefined): boolean =>
  live?.manifest !== null &&
  live?.manifest !== undefined &&
  live.manifest.generatedAt === record.generatedAt &&
  live.manifest.inputFingerprint === record.manifest.inputFingerprint &&
  live.manifest.output.bytes === record.output.bytes &&
  live.manifest.output.mtimeMs === record.output.mtimeMs &&
  live.manifest.output.ino === record.output.ino;

export type LibraryDeliveryFacts = {
  readonly count: number;
  readonly lastDeliveredAt: string | null;
};

export type ContentLibraryEntry = {
  readonly record: ContentLibraryRecord;
  readonly status: LibraryEntryStatus;
  /** The next version of the same track and format, if any. */
  readonly supersededBy: string | null;
  /** Null when no destination is configured or its log could not be read. */
  readonly deliveries: LibraryDeliveryFacts | null;
};

const byGeneratedThenAppended = (
  a: { readonly record: ContentLibraryRecord; readonly index: number },
  b: { readonly record: ContentLibraryRecord; readonly index: number },
): number => {
  const difference = Date.parse(a.record.generatedAt) - Date.parse(b.record.generatedAt);
  return difference !== 0 ? difference : a.index - b.index;
};

/**
 * Attributes deliveries to the version that was on disk when each happened.
 *
 * A delivery copies whatever export is current at that moment, so a delivery
 * of a track/format belongs to the latest version generated before it. The
 * input fingerprint is a guard on top of the time window: a delivery whose
 * fingerprint does not match that version is not counted against it.
 */
const attributeDeliveries = (
  ordered: readonly ContentLibraryRecord[],
  nextGeneratedAt: ReadonlyMap<string, string>,
  events: readonly DeliveryLogEvent[],
): Map<string, LibraryDeliveryFacts> => {
  const facts = new Map<string, LibraryDeliveryFacts>();
  const eventsByKey = new Map<string, DeliveryLogEvent[]>();

  for (const event of events) {
    const key = libraryTargetKey(event.track.slug, event.preset.id);
    const list = eventsByKey.get(key) ?? [];
    list.push(event);
    eventsByKey.set(key, list);
  }

  for (const record of ordered) {
    const key = libraryTargetKey(record.track.slug, record.preset.id);
    const next = nextGeneratedAt.get(record.recordId);
    const from = Date.parse(record.generatedAt);
    const to = next !== undefined ? Date.parse(next) : Number.POSITIVE_INFINITY;

    let count = 0;
    let lastDeliveredAt: string | null = null;

    for (const event of eventsByKey.get(key) ?? []) {
      const at = Date.parse(event.deliveredAt);
      if (at < from || at >= to) continue;
      if (event.exportFingerprint !== record.manifest.inputFingerprint) continue;
      count += 1;
      if (lastDeliveredAt === null || at > Date.parse(lastDeliveredAt)) lastDeliveredAt = event.deliveredAt;
    }

    facts.set(record.recordId, { count, lastDeliveredAt });
  }

  return facts;
};

/**
 * Every record, with its derived status, successor and delivery facts, in
 * append order.
 *
 * Computed over the whole library, because "was this superseded?" can only
 * be answered against everything after it — a filtered page cannot know.
 * `deliveryEvents` is null when there is no destination to ask.
 */
export const buildLibraryEntries = (
  records: readonly ContentLibraryRecord[],
  live: ReadonlyMap<string, LiveExportFacts>,
  deliveryEvents: readonly DeliveryLogEvent[] | null,
): readonly ContentLibraryEntry[] => {
  const ordered = records
    .map((record, index) => ({ record, index }))
    .sort(byGeneratedThenAppended)
    .map(({ record }) => record);

  const successor = new Map<string, string>();
  const nextGeneratedAt = new Map<string, string>();
  const latestByKey = new Map<string, ContentLibraryRecord>();
  for (const record of ordered) {
    const key = libraryTargetKey(record.track.slug, record.preset.id);
    const previous = latestByKey.get(key);
    if (previous !== undefined) {
      successor.set(previous.recordId, record.recordId);
      nextGeneratedAt.set(previous.recordId, record.generatedAt);
    }
    latestByKey.set(key, record);
  }

  const delivered =
    deliveryEvents === null ? null : attributeDeliveries(ordered, nextGeneratedAt, deliveryEvents);

  return records.map((record) => {
    const facts = live.get(libraryTargetKey(record.track.slug, record.preset.id));
    const supersededBy = successor.get(record.recordId) ?? null;

    let status: LibraryEntryStatus;
    if (holdsThisVersion(record, facts)) {
      status =
        facts!.freshness === "missing"
          ? "missing"
          : facts!.freshness === "current"
            ? "current"
            : "stale";
    } else if (supersededBy !== null) {
      status = "superseded";
    } else if (facts === undefined || facts.freshness === "missing") {
      status = "missing";
    } else {
      // A different, unrecorded export sits there now (rendered before the
      // library existed, or its own record could not be written): this
      // version was replaced all the same.
      status = "superseded";
    }

    return {
      record,
      status,
      supersededBy,
      deliveries: delivered?.get(record.recordId) ?? (delivered === null ? null : { count: 0, lastDeliveredAt: null }),
    };
  });
};

/* ------------------------------------------------------------------ *
 * Querying
 * ------------------------------------------------------------------ */

export type ContentLibraryOrder = "newest" | "oldest";

export type ContentLibraryFilter = {
  readonly track?: string | null;
  readonly preset?: string | null;
  readonly status?: LibraryEntryStatus | null;
  readonly exportKind?: ExportKind | null;
  readonly renderJobId?: string | null;
  readonly recordId?: string | null;
  /** Inclusive ISO lower bound on `generatedAt`. */
  readonly from?: string | null;
  /** Exclusive ISO upper bound, so adjacent ranges never double-count. */
  readonly to?: string | null;
  readonly limit?: number;
  readonly order?: ContentLibraryOrder;
};

export type ContentLibrarySelection = {
  readonly entries: readonly ContentLibraryEntry[];
  /** How many matched before the limit was applied. */
  readonly matched: number;
};

const instantOrNull = (value: string | null | undefined): number | null => {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
};

/**
 * Applies a filter to entries already built. Kept apart from reading so the
 * API, the CLI and the UI filter identically. Ordered by generation time with
 * append order as the tie-break.
 */
export const selectContentLibrary = (
  entries: readonly ContentLibraryEntry[],
  filter: ContentLibraryFilter = {},
): ContentLibrarySelection => {
  const from = instantOrNull(filter.from);
  const to = instantOrNull(filter.to);
  const requested = filter.limit;
  const limit = Math.min(
    Math.max(
      Number.isFinite(requested) ? Math.floor(requested as number) : CONTENT_LIBRARY_DEFAULT_LIMIT,
      1,
    ),
    CONTENT_LIBRARY_MAX_LIMIT,
  );

  const matched = entries
    .map((entry, index) => ({ record: entry.record, entry, index }))
    .filter(({ entry }) => {
      const { record } = entry;
      const at = Date.parse(record.generatedAt);
      return (
        (!filter.track || record.track.slug === filter.track) &&
        (!filter.preset || record.preset.id === filter.preset) &&
        (!filter.status || entry.status === filter.status) &&
        (!filter.exportKind || record.exportKind === filter.exportKind) &&
        (!filter.renderJobId || record.renderJobId === filter.renderJobId) &&
        (!filter.recordId || record.recordId === filter.recordId) &&
        (from === null || at >= from) &&
        (to === null || at < to)
      );
    });

  const sorted = [...matched].sort(byGeneratedThenAppended);
  if ((filter.order ?? "newest") === "newest") sorted.reverse();

  return {
    entries: sorted.slice(0, limit).map(({ entry }) => entry),
    matched: matched.length,
  };
};

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

export type LibraryFormatSummary = {
  readonly presetId: string;
  readonly label: string;
  readonly versions: number;
  readonly latestRecordId: string | null;
  readonly latestGeneratedAt: string | null;
  readonly latestStatus: LibraryEntryStatus | null;
};

/**
 * Which formats have been generated for one track, and where each stands.
 *
 * Every known format is listed, generated or not, so "never generated" is
 * visible rather than silently absent; a format that only appears in history
 * (a retired preset) is listed after them.
 */
export const summarizeTrackFormats = (
  entries: readonly ContentLibraryEntry[],
  slug: string,
  knownPresets: readonly { readonly id: string; readonly label: string }[],
): readonly LibraryFormatSummary[] => {
  const forTrack = entries
    .map((entry, index) => ({ record: entry.record, entry, index }))
    .filter(({ record }) => record.track.slug === slug)
    .sort(byGeneratedThenAppended);

  const presetIds = [
    ...knownPresets.map((preset) => preset.id),
    ...forTrack
      .map(({ record }) => record.preset.id)
      .filter((id, index, all) => all.indexOf(id) === index)
      .filter((id) => !knownPresets.some((preset) => preset.id === id)),
  ];

  return presetIds.map((presetId) => {
    const versions = forTrack.filter(({ record }) => record.preset.id === presetId);
    const latest = versions.at(-1)?.entry ?? null;
    return {
      presetId,
      label:
        knownPresets.find((preset) => preset.id === presetId)?.label ??
        latest?.record.preset.label ??
        presetId,
      versions: versions.length,
      latestRecordId: latest?.record.recordId ?? null,
      latestGeneratedAt: latest?.record.generatedAt ?? null,
      latestStatus: latest?.status ?? null,
    };
  });
};

export type ContentLibrarySummary = {
  readonly total: number;
  readonly tracks: number;
  readonly byStatus: Readonly<Record<LibraryEntryStatus, number>>;
  readonly lastGeneratedAt: string | null;
};

export const summarizeContentLibrary = (
  entries: readonly ContentLibraryEntry[],
): ContentLibrarySummary => {
  const byStatus: Record<LibraryEntryStatus, number> = {
    current: 0,
    stale: 0,
    superseded: 0,
    missing: 0,
  };
  let lastGeneratedAt: string | null = null;

  for (const entry of entries) {
    byStatus[entry.status] += 1;
    if (lastGeneratedAt === null || Date.parse(entry.record.generatedAt) > Date.parse(lastGeneratedAt)) {
      lastGeneratedAt = entry.record.generatedAt;
    }
  }

  return {
    total: entries.length,
    tracks: new Set(entries.map((entry) => entry.record.track.slug)).size,
    byStatus,
    lastGeneratedAt,
  };
};

/* ------------------------------------------------------------------ *
 * Parsing a query from outside (HTTP query string, CLI flags)
 * ------------------------------------------------------------------ */

/** Raw, untrusted filter values, as a query string or argv supplies them. */
export type RawContentLibraryQuery = Readonly<Record<
  "track" | "preset" | "status" | "kind" | "job" | "id" | "from" | "to" | "since" | "order" | "limit",
  string | null | undefined
>>;

const PRESET_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JOB_ID = /^[A-Za-z0-9-]{1,100}$/;

const refuse = (message: string): never => {
  throw new TrackError(trackIssue("INVALID_REQUEST", message));
};

const present = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim().length === 0 ? null : value.trim();

const instant = (value: string | null, name: string, now: Date): string | null => {
  if (value === null) return null;
  const relative = parseRelativePeriod(value, now);
  if (relative !== null) return relative;
  if (Number.isNaN(Date.parse(value))) {
    return refuse(
      `"${name}" must be an ISO timestamp such as 2026-09-12T00:00:00.000Z, ` +
        `or a period such as 7d or 24h. Received "${value}".`,
    );
  }
  return new Date(value).toISOString();
};

/**
 * Validates every filter value once, for the API and the CLI alike.
 *
 * `preset` is checked for shape, not against the current preset list, on
 * purpose: history outlives presets, and filtering by a retired format must
 * still work. Nothing here is ever used to build a path — every value is only
 * compared against recorded strings — but nothing unexpected gets through.
 */
export const parseContentLibraryQuery = (
  raw: Partial<RawContentLibraryQuery>,
  now: Date = new Date(),
): Required<Pick<ContentLibraryFilter, "limit" | "order">> & ContentLibraryFilter => {
  const track = present(raw.track);
  const preset = present(raw.preset);
  const status = present(raw.status);
  const kind = present(raw.kind);
  const job = present(raw.job);
  const id = present(raw.id);
  const order = present(raw.order);
  const limitText = present(raw.limit);

  if (track !== null && !isValidSlug(track)) refuse(`"track" must be a track slug such as ghetto-geek.`);
  if (preset !== null && !PRESET_ID.test(preset)) refuse(`"preset" is not a format id.`);
  if (status !== null && !LIBRARY_ENTRY_STATUSES.includes(status as LibraryEntryStatus)) {
    refuse(`"status" must be one of: ${LIBRARY_ENTRY_STATUSES.join(", ")}.`);
  }
  if (kind !== null && kind !== "original" && kind !== "reexport") {
    refuse(`"kind" must be "original" or "reexport".`);
  }
  if (job !== null && !JOB_ID.test(job)) refuse(`"job" is not a render job id.`);
  if (id !== null && !CONTENT_LIBRARY_RECORD_ID_PATTERN.test(id)) refuse(`"id" is not a content library record id.`);
  if (order !== null && order !== "newest" && order !== "oldest") refuse(`"order" must be "newest" or "oldest".`);

  let limit = CONTENT_LIBRARY_DEFAULT_LIMIT;
  if (limitText !== null) {
    const parsed = Number(limitText);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > CONTENT_LIBRARY_MAX_LIMIT) {
      refuse(`"limit" must be a whole number between 1 and ${CONTENT_LIBRARY_MAX_LIMIT}.`);
    }
    limit = parsed;
  }

  const from = instant(present(raw.from), "from", now);
  const since = instant(present(raw.since), "since", now);
  if (from !== null && since !== null) refuse(`Give "from" or "since", not both.`);

  return {
    track,
    preset,
    status: status as LibraryEntryStatus | null,
    exportKind: kind as ExportKind | null,
    renderJobId: job,
    recordId: id,
    from: from ?? since,
    to: instant(present(raw.to), "to", now),
    order: (order ?? "newest") as ContentLibraryOrder,
    limit,
  };
};
