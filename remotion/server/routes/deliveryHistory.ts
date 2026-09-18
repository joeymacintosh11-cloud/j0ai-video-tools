import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DeliveryHistoryReconcileView,
  DeliveryHistoryView,
} from "../../src/domain/api/views.ts";
import {
  DELIVERY_HISTORY_DEFAULT_LIMIT,
  DELIVERY_HISTORY_MAX_LIMIT,
  DELIVERY_LOG_STATUS_NOTES,
  parseRelativePeriod,
  type DeliveryHistoryOrder,
} from "../../src/domain/delivery/deliveryHistory.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import { readDeliverySettings } from "../../services/delivery/deliverySettings.ts";
import { sendOk } from "../http/json.ts";
import {
  queryDeliveryHistory,
  reconcileDeliveryHistory,
} from "../services/deliveryHistory.ts";

/**
 * Reads the destination's append-only delivery history.
 *
 * Read-only apart from the reconcile action, which only ever appends. No
 * endpoint here accepts a path: the destination comes from stored settings,
 * exactly as it does for delivery and for release bundles, and every filter is
 * validated before it reaches the log.
 *
 * The limit is bounded whether or not the caller sets one, so no request can
 * ask for an unbounded response even once this log has years in it.
 */

const invalid = (message: string): never => {
  throw new TrackError(trackIssue("INVALID_REQUEST", message));
};

/** An ISO timestamp, or a relative period such as "7d" or "24h". */
const readInstant = (
  value: string | null,
  name: string,
): string | null => {
  if (value === null || value.trim().length === 0) return null;

  const raw = value.trim();
  const relative = parseRelativePeriod(raw);

  if (relative !== null) return relative;

  if (Number.isNaN(Date.parse(raw))) {
    return invalid(
      `"${name}" must be an ISO timestamp such as 2026-09-12T00:00:00.000Z, ` +
        `or a period such as 7d or 24h. Received "${raw}".`,
    );
  }

  return new Date(raw).toISOString();
};

const readLimit = (value: string | null): number => {
  if (value === null) return DELIVERY_HISTORY_DEFAULT_LIMIT;

  const limit = Number(value);

  if (!Number.isInteger(limit) || limit < 1 || limit > DELIVERY_HISTORY_MAX_LIMIT) {
    return invalid(
      `"limit" must be a whole number between 1 and ${DELIVERY_HISTORY_MAX_LIMIT}.`,
    );
  }

  return limit;
};

const readOrder = (value: string | null): DeliveryHistoryOrder => {
  if (value === null) return "newest";
  if (value !== "newest" && value !== "oldest") {
    return invalid('"order" must be "newest" or "oldest".');
  }
  return value;
};

/**
 * A preset filter is not checked against the known presets on purpose.
 *
 * History outlives the preset list: an event records the format as it was, so
 * filtering by a format that has since been renamed or retired must still work.
 * The value is only ever compared against recorded strings, never used to build
 * a path.
 */
const readPreset = (value: string | null): string | null => {
  if (value === null || value.trim().length === 0) return null;

  const preset = value.trim();

  if (preset.length > 64) return invalid('"preset" is too long to be a format id.');

  return preset;
};

export const handleGetDeliveryHistory = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const { searchParams } = new URL(request.url ?? "/", "http://localhost");
  const track = searchParams.get("track");
  const limit = readLimit(searchParams.get("limit"));

  const result = await queryDeliveryHistory({
    settings: await readDeliverySettings(),
    filter: {
      // Validated as a slug even though it is only ever compared against
      // recorded values: a filter has no business carrying anything else.
      track: track === null || track.trim().length === 0 ? null : assertValidSlug(track),
      preset: readPreset(searchParams.get("preset")),
      from: readInstant(searchParams.get("from"), "from"),
      to: readInstant(searchParams.get("to"), "to"),
      limit,
      order: readOrder(searchParams.get("order")),
    },
  });

  const payload: DeliveryHistoryView = {
    root: result.root,
    rootProblem: result.rootProblem,
    status: result.status,
    statusNote: DELIVERY_LOG_STATUS_NOTES[result.status],
    problems: result.problems,
    events: result.events,
    matched: result.matched,
    limit,
    summary: result.summary,
    knownTracks: result.knownTracks,
    redelivered: result.redelivered,
  };

  sendOk(response, payload);
};

/**
 * Appends events for receipts that have none.
 *
 * A write, so it is a POST, and it is never triggered by browsing. It only ever
 * appends: no event is rewritten, and nothing that cannot be reconstructed
 * faithfully is guessed at.
 */
export const handleReconcileDeliveryHistory = async (
  response: ServerResponse,
): Promise<void> => {
  const result = await reconcileDeliveryHistory({
    settings: await readDeliverySettings(),
  });

  const payload: DeliveryHistoryReconcileView = {
    root: result.root,
    rootProblem: result.rootProblem,
    scanned: result.scanned,
    alreadyRecorded: result.alreadyRecorded,
    appended: result.appended,
    unreconcilable: result.unreconcilable,
    problem: result.problem,
  };

  sendOk(response, payload);
};
