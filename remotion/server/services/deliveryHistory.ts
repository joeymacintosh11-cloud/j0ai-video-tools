import { readdirSync } from "node:fs";
import {
  DELIVERY_HISTORY_DEFAULT_LIMIT,
  redeliveredEventIds,
  selectDeliveryHistory,
  summarizeDeliveryHistory,
  type DeliveryHistoryFilter,
  type DeliveryHistorySummary,
  type DeliveryLogEvent,
  type DeliveryLogProblem,
  type DeliveryLogStatus,
} from "../../src/domain/delivery/deliveryHistory.ts";
import { isValidSlug } from "../../src/domain/tracks/slug.ts";
import { RENDER_PRESET_IDS } from "../../src/domain/video/renderPresets.ts";
import {
  deliveryEventFor,
  deliveryIdForReceipt,
} from "../../services/delivery/deliveryHistory.ts";
import {
  appendDeliveryLogEvent,
  readDeliveryLog,
} from "../../services/delivery/deliveryHistoryLog.ts";
import {
  readDeliveryReceipt,
  type DeliveryReceipt,
} from "../../services/delivery/deliveryReceipt.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "../../services/delivery/deliverySettings.ts";
import { inspectTrack } from "../../services/tracks/inspectTrack.ts";
import { OUT_DIR } from "../../services/tracks/trackLocations.ts";

/**
 * Queries the destination's delivery history, and reconciles it with receipts.
 *
 * Filtering, ordering and limiting all happen here rather than in a client, so
 * the API, the CLI and the UI ask the same questions and get the same answers,
 * and no response is ever unbounded. The log is read through one function that
 * hands back events and a status, so a streaming reader can replace the
 * full-file read without any of this changing.
 *
 * Nothing here is a source of truth for what is *currently* delivered — that is
 * the receipts', and the release bundle's. A missing or damaged log makes the
 * history unavailable and changes nothing about delivery state.
 */

export type DeliveryHistoryResult = {
  readonly root: string | null;
  readonly rootProblem: string | null;
  readonly status: DeliveryLogStatus;
  readonly problems: readonly DeliveryLogProblem[];
  /** Events matching the filter, ordered and limited. */
  readonly events: readonly DeliveryLogEvent[];
  /** How many matched the filter before the limit was applied. */
  readonly matched: number;
  /** The whole log's counts, which is what a destination summary means. */
  readonly summary: DeliveryHistorySummary;
  /** Every track slug that appears anywhere in the log, for a filter list. */
  readonly knownTracks: readonly { readonly slug: string; readonly title: string }[];
  /** Ids of returned events that are not the first delivery of their format. */
  readonly redelivered: readonly string[];
};

const EMPTY_SUMMARY: DeliveryHistorySummary = {
  total: 0,
  today: 0,
  last7Days: 0,
  tracksLast7Days: 0,
  lastDeliveredAt: null,
  byTrack: [],
  byPreset: [],
};

export type QueryDeliveryHistoryInput = {
  readonly filter?: DeliveryHistoryFilter;
  readonly settings?: DeliverySettings;
  /** Injected so summary boundaries are reproducible in tests. */
  readonly now?: Date;
};

/**
 * Everything a history view needs, in one read.
 *
 * The summary is always of the whole log, because "6 deliveries today" is a
 * fact about the destination rather than about whatever is currently filtered.
 * The event list is the filtered, ordered, limited answer.
 */
export const queryDeliveryHistory = async ({
  filter = {},
  settings,
  now = new Date(),
}: QueryDeliveryHistoryInput): Promise<DeliveryHistoryResult> => {
  const resolved = settings ?? (await readDeliverySettings());
  const { root, problem } = resolveDeliveryRoot(resolved);

  if (root === null) {
    return {
      root: null,
      rootProblem: problem,
      status: "missing",
      problems: [],
      events: [],
      matched: 0,
      summary: EMPTY_SUMMARY,
      knownTracks: [],
      redelivered: [],
    };
  }

  const read = readDeliveryLog(root);
  const selection = selectDeliveryHistory(read.events, {
    limit: DELIVERY_HISTORY_DEFAULT_LIMIT,
    ...filter,
  });
  const summary = summarizeDeliveryHistory(read.events, now);
  // Against the whole log, not the page: a page cannot see what preceded it.
  const repeats = redeliveredEventIds(read.events);

  return {
    root,
    rootProblem: problem,
    status: read.status,
    problems: read.problems,
    events: selection.events,
    matched: selection.matched,
    summary,
    knownTracks: summary.byTrack.map(({ key, label }) => ({
      slug: key,
      title: label,
    })),
    redelivered: selection.events
      .filter((event) => repeats.has(event.eventId))
      .map((event) => event.eventId),
  };
};

/* ------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------ */

export type UnreconciledDelivery = {
  readonly slug: string;
  readonly presetId: string;
  readonly reason: string;
};

export type ReconcileDeliveryHistoryResult = {
  readonly root: string | null;
  readonly rootProblem: string | null;
  /** Receipts examined. */
  readonly scanned: number;
  /** Receipts that already had an event. */
  readonly alreadyRecorded: number;
  readonly appended: readonly DeliveryLogEvent[];
  readonly unreconcilable: readonly UnreconciledDelivery[];
  readonly problem: string | null;
};

/**
 * Every delivery receipt this project holds, oldest delivery first.
 *
 * A shallow read of `out/` — our own directory, one entry per track — and then
 * one small file read per known format. Deliberately not a scan of the
 * destination: receipts are the record of what was delivered, and an MP4 at the
 * destination has never been evidence of anything on its own.
 */
const allReceipts = (): readonly DeliveryReceipt[] => {
  let slugs: readonly string[];

  try {
    slugs = readdirSync(OUT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isValidSlug(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }

  return slugs
    .flatMap((slug) =>
      RENDER_PRESET_IDS.map((presetId) => readDeliveryReceipt(slug, presetId)),
    )
    .filter((receipt): receipt is DeliveryReceipt => receipt !== null)
    .sort((a, b) => Date.parse(a.deliveredAt) - Date.parse(b.deliveredAt));
};

/**
 * Appends events for deliveries that happened but were never recorded.
 *
 * The one case this exists for is a crash between committing a receipt and
 * appending its event. It is conservative by construction:
 *
 * - It reads **receipts only**, never the destination's contents.
 * - It never invents a timestamp, a size or a fingerprint: all three are on the
 *   receipt, recorded when the delivery happened.
 * - It skips a receipt that names a different destination, because an event's
 *   path is relative to the root its log sits in.
 * - What it genuinely cannot reconstruct is the track's metadata **as it was**
 *   at delivery time. Nothing records that, so a reconstructed event carries
 *   *current* metadata and is marked `source: "reconciled"` rather than being
 *   passed off as a contemporaneous record. A track whose metadata can no
 *   longer be read is reported as unreconcilable instead of being guessed at.
 * - It is idempotent: `deliveryId` is derived from the receipt, so a receipt
 *   already in the log is recognised and skipped.
 *
 * Only ever run when asked for. Nothing calls it automatically.
 */
export const reconcileDeliveryHistory = async ({
  settings,
}: { readonly settings?: DeliverySettings } = {}): Promise<ReconcileDeliveryHistoryResult> => {
  const resolved = settings ?? (await readDeliverySettings());
  const { root, problem } = resolveDeliveryRoot(resolved);

  if (root === null) {
    return {
      root: null,
      rootProblem: problem,
      scanned: 0,
      alreadyRecorded: 0,
      appended: [],
      unreconcilable: [],
      problem:
        problem ??
        "No export destination is configured, so there is no history to reconcile.",
    };
  }

  const read = readDeliveryLog(root);

  // Appending onto damage would bury it. A truncated tail is repaired on
  // request; anything worse is for someone to look at first.
  if (read.status === "corrupt" || read.status === "unsupported") {
    return {
      root,
      rootProblem: problem,
      scanned: 0,
      alreadyRecorded: 0,
      appended: [],
      unreconcilable: [],
      problem: `The delivery log reads as "${read.status}", so nothing was appended. Inspect it first.`,
    };
  }

  const recorded = new Set(read.events.map((event) => event.deliveryId));
  const receipts = allReceipts();
  const appended: DeliveryLogEvent[] = [];
  const unreconcilable: UnreconciledDelivery[] = [];
  let alreadyRecorded = 0;

  for (const receipt of receipts) {
    if (receipt.destinationRoot !== root) {
      unreconcilable.push({
        slug: receipt.slug,
        presetId: receipt.presetId,
        reason: `Delivered to ${receipt.destinationRoot}, which is not the current destination.`,
      });
      continue;
    }

    if (recorded.has(deliveryIdForReceipt(receipt))) {
      alreadyRecorded += 1;
      continue;
    }

    const metadata = (await inspectTrack(receipt.slug)).metadata;

    if (metadata === null) {
      unreconcilable.push({
        slug: receipt.slug,
        presetId: receipt.presetId,
        reason:
          "The track's metadata can no longer be read, so no snapshot of what was shipped can be reconstructed.",
      });
      continue;
    }

    const event = deliveryEventFor(receipt, metadata, "reconciled");
    const result = await appendDeliveryLogEvent(root, event);

    if (result.appended) appended.push(event);
    else if (result.duplicate) alreadyRecorded += 1;
    else {
      unreconcilable.push({
        slug: receipt.slug,
        presetId: receipt.presetId,
        reason: result.problem ?? "The event could not be appended.",
      });
    }
  }

  return {
    root,
    rootProblem: problem,
    scanned: receipts.length,
    alreadyRecorded,
    appended,
    unreconcilable,
    problem: null,
  };
};
