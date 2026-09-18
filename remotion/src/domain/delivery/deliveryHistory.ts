import { formatBytes, formatBundleTimestamp } from "./releaseBundle.ts";

/**
 * The append-only record of what has gone out to a destination.
 *
 * A release bundle answers "what does this track currently ship?". This
 * answers a different question — "what went out, and when?" — and it answers it
 * about the destination as a whole rather than about one track. The two never
 * derive from each other: a bundle is current state recomputed from disk, and
 * this is history, which is written once and never rewritten.
 *
 * Pure and browser-safe, so the event shape, the validation rules and the
 * report rendering live in one place and the server, the CLI and the UI all
 * agree on them.
 *
 * Nothing here knows an absolute path. The log sits at the destination root, so
 * an event records the delivered file's path *relative to that root* and the
 * root itself is never repeated into portable data.
 */

export const DELIVERY_LOG_SCHEMA_VERSION = 1;
export const DELIVERY_LOG_FILENAME = "delivery-log.jsonl";
export const DELIVERY_REPORT_FILENAME = "delivery-report.md";

/** How many events a query returns when the caller does not say. */
export const DELIVERY_HISTORY_DEFAULT_LIMIT = 50;
/** Hard ceiling, so no request can ask for an unbounded response. */
export const DELIVERY_HISTORY_MAX_LIMIT = 500;

/**
 * How an event came to be written.
 *
 * - `delivery`:   appended by the delivery that it describes, from live state.
 * - `reconciled`: reconstructed later from a delivery receipt. Its timestamp,
 *                 size and fingerprint are the real recorded ones, but its
 *                 track snapshot is *current* metadata rather than metadata as
 *                 it was at delivery time. Marked so a reader is never misled
 *                 about which is which.
 */
export type DeliveryLogEventSource = "delivery" | "reconciled";

/** What the track was called when this went out. */
export type DeliveryLogTrack = {
  readonly slug: string;
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: number;
  readonly subtitle?: string;
};

/**
 * The format as it was defined when this went out.
 *
 * Recorded in full rather than referenced by id, so renaming or retiring a
 * preset cannot change or invalidate what history says was shipped. `id` is a
 * plain string for the same reason: an event must stay readable after the
 * preset it names has gone.
 */
export type DeliveryLogPreset = {
  readonly id: string;
  readonly label: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
};

export type DeliveryLogEvent = {
  readonly schemaVersion: number;
  /** Unique per appended event. Never an index or a line number. */
  readonly eventId: string;
  readonly kind: "delivery";
  readonly source: DeliveryLogEventSource;
  readonly deliveredAt: string;
  readonly track: DeliveryLogTrack;
  readonly preset: DeliveryLogPreset;
  /** Portable: relative to the destination root this log sits in. */
  readonly path: string;
  readonly bytes: number;
  /** The canonical export's input fingerprint, for tracing what shipped. */
  readonly exportFingerprint: string;
  /**
   * Identity of the *completed delivery* this event describes, derived from its
   * receipt. Two appends of the same completion carry the same value, so an
   * accidental duplicate is detectable; a genuine later re-delivery produces a
   * new receipt and therefore a different value.
   */
  readonly deliveryId: string;
};

/**
 * The text a delivery's identity is hashed from.
 *
 * Deliberately every fact that makes one completed copy distinct from the next:
 * re-delivering the same export writes a new receipt with a new timestamp and a
 * new file modification time, so it is a new delivery and gets its own event.
 * Hashed by the service layer, because hashing is not browser-safe.
 */
export type DeliveryIdInput = {
  readonly slug: string;
  readonly presetId: string;
  readonly path: string;
  readonly deliveredAt: string;
  readonly bytes: number;
  readonly mtimeMs: number;
  readonly exportFingerprint: string;
  readonly sourceOutput: string;
};

export const deliveryIdText = (input: DeliveryIdInput): string =>
  JSON.stringify([
    input.slug,
    input.presetId,
    input.path,
    input.deliveredAt,
    input.bytes,
    input.mtimeMs,
    input.exportFingerprint,
    input.sourceOutput,
  ]);

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * - malformed:   not parseable, or not a delivery event of a version we know.
 * - unsupported: written by a newer version of the tool than this one.
 * - truncated:   an incomplete final line, which a crash mid-append can leave.
 */
export type DeliveryLogProblemKind = "malformed" | "unsupported" | "truncated";

export type DeliveryLogProblem = {
  /** 1-based, so it matches what an editor shows. */
  readonly line: number;
  readonly kind: DeliveryLogProblemKind;
  readonly message: string;
};

/**
 * - missing:        no log at this destination yet. Not a problem.
 * - complete:       every line parsed.
 * - recovered_tail: only the final line was incomplete. Every event before it
 *                   is intact, and `--repair-tail` can drop the fragment.
 * - unsupported:    at least one line came from a newer version of the tool.
 *                   Earlier events are still readable; nothing is rewritten.
 * - corrupt:        damage somewhere other than the final line. Treated as the
 *                   serious case, because a crash cannot cause it.
 */
export type DeliveryLogStatus =
  | "missing"
  | "complete"
  | "recovered_tail"
  | "unsupported"
  | "corrupt";

export type DeliveryLogRead = {
  readonly status: DeliveryLogStatus;
  /** Every event that parsed, in the order it was appended. */
  readonly events: readonly DeliveryLogEvent[];
  readonly problems: readonly DeliveryLogProblem[];
  /** Lines considered, including blank and unparseable ones. */
  readonly lines: number;
};

export type ParsedDeliveryLogLine =
  | { readonly ok: true; readonly event: DeliveryLogEvent }
  | {
      readonly ok: false;
      readonly kind: Exclude<DeliveryLogProblemKind, "truncated">;
      readonly message: string;
    };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

const validTrack = (value: unknown): value is DeliveryLogTrack => {
  const track = value as DeliveryLogTrack | undefined;

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

const validPreset = (value: unknown): value is DeliveryLogPreset => {
  const preset = value as DeliveryLogPreset | undefined;

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

/**
 * One line of the log, validated.
 *
 * A future schema version is reported as `unsupported` rather than as damage:
 * the line is perfectly well-formed, this version simply does not know it, and
 * saying so is what stops a newer log being treated as corrupt (or, worse,
 * being rewritten).
 */
export const parseDeliveryLogLine = (line: string): ParsedDeliveryLogLine => {
  let value: unknown;

  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, kind: "malformed", message: "not valid JSON" };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, kind: "malformed", message: "not a JSON object" };
  }

  const event = value as Partial<DeliveryLogEvent>;

  if (!Number.isInteger(event.schemaVersion) || (event.schemaVersion ?? 0) < 1) {
    return { ok: false, kind: "malformed", message: "no usable schemaVersion" };
  }

  if ((event.schemaVersion as number) > DELIVERY_LOG_SCHEMA_VERSION) {
    return {
      ok: false,
      kind: "unsupported",
      message:
        `schemaVersion ${event.schemaVersion} was written by a newer version of ` +
        `this tool (this one reads ${DELIVERY_LOG_SCHEMA_VERSION})`,
    };
  }

  if (event.kind !== "delivery") {
    return { ok: false, kind: "malformed", message: `unknown kind "${String(event.kind)}"` };
  }

  const timestamp = typeof event.deliveredAt === "string" ? Date.parse(event.deliveredAt) : NaN;

  if (
    !isNonEmptyString(event.eventId) ||
    !isNonEmptyString(event.deliveryId) ||
    (event.source !== "delivery" && event.source !== "reconciled") ||
    Number.isNaN(timestamp) ||
    !validTrack(event.track) ||
    !validPreset(event.preset) ||
    !isNonEmptyString(event.path) ||
    !Number.isFinite(event.bytes) ||
    (event.bytes as number) < 0 ||
    typeof event.exportFingerprint !== "string"
  ) {
    return { ok: false, kind: "malformed", message: "not a well-formed delivery event" };
  }

  return { ok: true, event: event as DeliveryLogEvent };
};

/**
 * Parses the whole log from its text.
 *
 * Split from reading the file so the rules are testable without a filesystem,
 * and so the file read can be replaced by a streaming one later without any of
 * this changing.
 *
 * `endsWithNewline` is what distinguishes the two failure modes that matter. An
 * append is one write of one line ending in a newline, so a *final* line with
 * no newline is an interrupted append — recoverable, and expected after a hard
 * crash. Anything else, including a damaged line in the middle, is real
 * corruption and is reported as such.
 */
export const parseDeliveryLog = (text: string): DeliveryLogRead => {
  const events: DeliveryLogEvent[] = [];
  const problems: DeliveryLogProblem[] = [];
  const endsWithNewline = text.length === 0 || text.endsWith("\n");
  const rows = text.split("\n");

  // A trailing newline produces one empty final element, which is not a line.
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();

  rows.forEach((row, index) => {
    const line = index + 1;
    const isFinal = index === rows.length - 1;

    if (row.trim().length === 0) return;

    const parsed = parseDeliveryLogLine(row);

    if (parsed.ok) {
      events.push(parsed.event);
      return;
    }

    problems.push({
      line,
      kind: isFinal && !endsWithNewline && parsed.kind === "malformed"
        ? "truncated"
        : parsed.kind,
      message: parsed.message,
    });
  });

  const status: DeliveryLogStatus = problems.some((p) => p.kind === "malformed")
    ? "corrupt"
    : problems.some((p) => p.kind === "unsupported")
      ? "unsupported"
      : problems.some((p) => p.kind === "truncated")
        ? "recovered_tail"
        : "complete";

  return { status, events, problems, lines: rows.length };
};

/** A log whose damage is not simply an interrupted final append. */
export const isSeriousLogDamage = (status: DeliveryLogStatus): boolean =>
  status === "corrupt" || status === "unsupported";

export const DELIVERY_LOG_STATUS_NOTES: Record<DeliveryLogStatus, string | null> = {
  missing: null,
  complete: null,
  recovered_tail:
    "The last line of the delivery log is incomplete, which is what an interrupted " +
    "append leaves behind. Every event before it was read. Run " +
    "`npm run delivery-history -- --repair-tail` to drop the fragment.",
  unsupported:
    "The delivery log contains events written by a newer version of this tool. " +
    "Earlier events were read; nothing was changed.",
  corrupt:
    "The delivery log is damaged somewhere other than its last line, which a " +
    "crash cannot cause. The events that could be read are shown. Nothing has " +
    "been rewritten — inspect the file before repairing it.",
};

/* ------------------------------------------------------------------ *
 * Querying
 * ------------------------------------------------------------------ */

export type DeliveryHistoryOrder = "newest" | "oldest";

export type DeliveryHistoryFilter = {
  readonly track?: string | null;
  readonly preset?: string | null;
  /** Inclusive ISO lower bound. */
  readonly from?: string | null;
  /** Exclusive ISO upper bound, so adjacent ranges never double-count. */
  readonly to?: string | null;
  readonly limit?: number;
  readonly order?: DeliveryHistoryOrder;
};

const withinRange = (
  event: DeliveryLogEvent,
  from: number | null,
  to: number | null,
): boolean => {
  const at = Date.parse(event.deliveredAt);

  if (from !== null && at < from) return false;
  if (to !== null && at >= to) return false;

  return true;
};

export type DeliveryHistorySelection = {
  /** Events matching the filter, ordered and limited. */
  readonly events: readonly DeliveryLogEvent[];
  /** How many matched before the limit was applied. */
  readonly matched: number;
};

/**
 * Applies a filter to events already read.
 *
 * Separate from reading so filtering stays server-side and identical for the
 * API, the CLI and any future streaming reader. Sorting is by delivery time
 * with the appended order as the tie-break, so two deliveries recorded in the
 * same millisecond keep the order they happened in.
 */
export const selectDeliveryHistory = (
  events: readonly DeliveryLogEvent[],
  filter: DeliveryHistoryFilter = {},
): DeliveryHistorySelection => {
  const from = filter.from ? Date.parse(filter.from) : null;
  const to = filter.to ? Date.parse(filter.to) : null;
  const limit = Math.min(
    Math.max(filter.limit ?? DELIVERY_HISTORY_DEFAULT_LIMIT, 1),
    DELIVERY_HISTORY_MAX_LIMIT,
  );

  const matched = events
    .map((event, index) => ({ event, index }))
    .filter(
      ({ event }) =>
        (!filter.track || event.track.slug === filter.track) &&
        (!filter.preset || event.preset.id === filter.preset) &&
        withinRange(event, Number.isNaN(from as number) ? null : from, Number.isNaN(to as number) ? null : to),
    );

  const sorted = [...matched].sort((a, b) => {
    const difference = Date.parse(a.event.deliveredAt) - Date.parse(b.event.deliveredAt);
    return difference !== 0 ? difference : a.index - b.index;
  });

  if ((filter.order ?? "newest") === "newest") sorted.reverse();

  return {
    events: sorted.slice(0, limit).map(({ event }) => event),
    matched: matched.length,
  };
};

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

export type DeliveryHistoryCount = {
  readonly key: string;
  readonly label: string;
  readonly count: number;
};

export type DeliveryHistorySummary = {
  readonly total: number;
  readonly today: number;
  readonly last7Days: number;
  /** Distinct tracks delivered in the last 7 days. */
  readonly tracksLast7Days: number;
  readonly lastDeliveredAt: string | null;
  /** Busiest tracks first, then alphabetically. */
  readonly byTrack: readonly DeliveryHistoryCount[];
  readonly byPreset: readonly DeliveryHistoryCount[];
};

const rank = (counts: Map<string, DeliveryHistoryCount>): DeliveryHistoryCount[] =>
  [...counts.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The counts worth showing at a glance.
 *
 * "Today" is local midnight rather than the last 24 hours, because that is what
 * someone means when they ask what they shipped today. The clock is a parameter
 * so a test can pin it.
 */
export const summarizeDeliveryHistory = (
  events: readonly DeliveryLogEvent[],
  now: Date = new Date(),
): DeliveryHistorySummary => {
  const midnight = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate(),
  ).getTime();
  const weekAgo = now.getTime() - 7 * DAY_MS;

  const byTrack = new Map<string, DeliveryHistoryCount>();
  const byPreset = new Map<string, DeliveryHistoryCount>();
  const recentTracks = new Set<string>();

  let today = 0;
  let last7Days = 0;
  let lastDeliveredAt: string | null = null;

  for (const event of events) {
    const at = Date.parse(event.deliveredAt);

    if (at >= midnight) today += 1;
    if (at >= weekAgo) {
      last7Days += 1;
      recentTracks.add(event.track.slug);
    }
    if (lastDeliveredAt === null || at > Date.parse(lastDeliveredAt)) {
      lastDeliveredAt = event.deliveredAt;
    }

    for (const [counts, key, label] of [
      [byTrack, event.track.slug, event.track.title],
      [byPreset, event.preset.id, event.preset.label],
    ] as const) {
      const existing = counts.get(key);
      counts.set(key, {
        key,
        label: existing?.label ?? label,
        count: (existing?.count ?? 0) + 1,
      });
    }
  }

  return {
    total: events.length,
    today,
    last7Days,
    tracksLast7Days: recentTracks.size,
    lastDeliveredAt,
    byTrack: rank(byTrack),
    byPreset: rank(byPreset),
  };
};

/* ------------------------------------------------------------------ *
 * Human-readable report
 * ------------------------------------------------------------------ */

// Spelled out rather than taken from toLocaleDateString, whose short month
// names differ between ICU versions ("Sep" and "Sept" both appear). A report
// that has to be byte-identical for identical events cannot depend on that.
const MONTHS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** "12 Sep 2026", for a report heading. */
const reportDate = (iso: string): string => {
  const parsed = new Date(iso);

  if (Number.isNaN(parsed.getTime())) return iso;

  return `${parsed.getDate()} ${MONTHS[parsed.getMonth()]} ${parsed.getFullYear()}`;
};

export type DeliveryReportRange = {
  readonly from: string | null;
  readonly to: string | null;
};

/**
 * A compact Markdown report over a chosen range.
 *
 * Fixed order and fixed formatting, so the same events always produce the same
 * document. It is a *view* of history and is regenerated rather than appended
 * to — nothing here ever becomes a source of truth.
 */
export const renderDeliveryReport = (
  events: readonly DeliveryLogEvent[],
  range: DeliveryReportRange,
  generatedAt: string,
): string => {
  const heading =
    range.from === null && range.to === null
      ? "# Delivery Report — everything"
      : `# Delivery Report — ${range.from ? reportDate(range.from) : "the beginning"}` +
        ` to ${range.to ? reportDate(range.to) : "now"}`;

  const tracks = new Set(events.map((event) => event.track.slug));
  const lines: string[] = [heading, ""];

  lines.push(
    `${events.length} ${events.length === 1 ? "delivery" : "deliveries"}`,
    `${tracks.size} ${tracks.size === 1 ? "track" : "tracks"}`,
  );

  if (events.length > 0) {
    lines.push("");
    // Newest first: the last thing shipped is what someone looks for.
    for (const event of [...events].sort(
      (a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt),
    )) {
      lines.push(
        `- ${event.track.title} — ${event.preset.label} — ` +
          `${formatBundleTimestamp(event.deliveredAt)} — ${formatBytes(event.bytes)}`,
      );
    }
  }

  lines.push("", "---", "", `Generated ${formatBundleTimestamp(generatedAt)}`, "");

  return lines.join("\n");
};

/* ------------------------------------------------------------------ *
 * Relative period parsing, shared by the CLI and the API
 * ------------------------------------------------------------------ */

/**
 * "7d", "24h", "30d" → an ISO lower bound.
 *
 * Small and deliberately closed: this is a convenience for "what went out this
 * week", not a date-expression language, and a wrong guess about what "1w"
 * means would be worse than not accepting it.
 */
export const parseRelativePeriod = (
  value: string,
  now: Date = new Date(),
): string | null => {
  const match = /^(\d{1,4})([hd])$/.exec(value.trim());

  if (match === null) return null;

  const amount = Number(match[1]);

  if (amount <= 0) return null;

  const ms = match[2] === "h" ? 60 * 60 * 1000 : DAY_MS;

  return new Date(now.getTime() - amount * ms).toISOString();
};
