import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  DeliveryHistoryReconcileView,
  DeliveryHistoryView,
  DeliveryLogEvent,
} from "../../src/domain/api/views.ts";
import { DELIVERY_LOG_STATUS_NOTES } from "../../src/domain/delivery/deliveryHistory.ts";
import {
  formatBundleTimestamp,
  formatBytes,
} from "../../src/domain/delivery/releaseBundle.ts";
import {
  ApiRequestError,
  getDeliveryHistory,
  reconcileDeliveryHistory,
} from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

/**
 * What has gone out to the destination, and when.
 *
 * Deliberately small: a list, three filters and the counts worth seeing at a
 * glance. Every filter is a server query rather than client-side work on a
 * downloaded log, so this stays cheap however long the history gets — and it
 * is what keeps the answers identical to the CLI's.
 *
 * Nothing here deletes or rewrites an event. The one write it offers is
 * reconciliation, which only appends, and repairing a damaged log is left to
 * the terminal where the file can be looked at first.
 */

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

const PERIODS = [
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "", label: "Everything" },
] as const;

/** One line of history: when, what, in which format, and how big. */
const HistoryRow: React.FC<{
  readonly event: DeliveryLogEvent;
  readonly redelivered: boolean;
}> = ({ event, redelivered }) => (
  <li className="history__row">
    <span className="history__when">{formatBundleTimestamp(event.deliveredAt)}</span>
    <span className="history__track">{event.track.title}</span>
    <span className="history__preset">{event.preset.label}</span>
    <span className="history__bytes">{formatBytes(event.bytes)}</span>
    <span className="history__path" title={event.path}>
      {event.path}
    </span>
    {redelivered ? (
      <span
        className="history__tag"
        title="This track and format had gone out at least once before"
      >
        re-delivered
      </span>
    ) : null}
    {event.source === "reconciled" ? (
      <span
        className="history__tag history__tag--reconstructed"
        title="Reconstructed from the delivery receipt. Its time and size are the recorded ones; its track details are current metadata."
      >
        reconstructed
      </span>
    ) : null}
  </li>
);

export const DeliveryHistoryPanel: React.FC<{
  readonly onChanged?: () => void;
}> = ({ onChanged }) => {
  const [history, setHistory] = useState<DeliveryHistoryView | null>(null);
  const [reconciled, setReconciled] =
    useState<DeliveryHistoryReconcileView | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const [track, setTrack] = useState("");
  const [preset, setPreset] = useState("");
  const [period, setPeriod] = useState<string>("7d");

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);

    try {
      setHistory(
        await getDeliveryHistory({
          ...(track ? { track } : {}),
          ...(preset ? { preset } : {}),
          ...(period ? { from: period } : {}),
          limit: 50,
        }),
      );
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  }, [track, preset, period]);

  useEffect(() => {
    void load();
  }, [load]);

  const repeats = useMemo(
    () => new Set(history?.redelivered ?? []),
    [history],
  );

  const reconcile = async () => {
    setBusy(true);
    setError(null);

    try {
      setReconciled(await reconcileDeliveryHistory());
      await load();
      onChanged?.();
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (error) {
    return <ErrorBanner error={error} title="Could not read delivery history" />;
  }

  if (history === null) {
    return <div className="placeholder">Loading…</div>;
  }

  if (history.root === null) {
    return (
      <p className="muted">
        {history.rootProblem ??
          "No export destination is configured, so nothing has been delivered from here yet."}
      </p>
    );
  }

  const { summary } = history;

  return (
    <div className="history">
      {/* The destination's own summary, which is what "what did I ship this
          week?" actually asks — never the filtered page's. */}
      <p className="history__summary">
        <strong>{summary.today}</strong> today ·{" "}
        <strong>{summary.last7Days}</strong> this week across{" "}
        {summary.tracksLast7Days} track{summary.tracksLast7Days === 1 ? "" : "s"} ·{" "}
        {summary.total} recorded in all
      </p>
      {summary.lastDeliveredAt === null ? null : (
        <p className="muted">
          Last delivery {formatBundleTimestamp(summary.lastDeliveredAt)}
        </p>
      )}

      {/* Said plainly rather than swallowed: a log that cannot be read whole
          is something the user needs to know about, and the note names the
          command that repairs the one case that is safely repairable. */}
      {history.statusNote === null ? null : (
        <p className="note note--warning">
          <span className="note__message">
            {history.statusNote}
            {history.problems.length > 0
              ? ` (line ${history.problems.map((problem) => problem.line).join(", ")})`
              : ""}
          </span>
        </p>
      )}

      <div className="history__filters">
        <label className="field field--inline">
          <span className="field__label">Track</span>
          <select
            className="field__input"
            value={track}
            onChange={(changed) => setTrack(changed.target.value)}
          >
            <option value="">Every track</option>
            {history.knownTracks.map((known) => (
              <option key={known.slug} value={known.slug}>
                {known.title}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--inline">
          <span className="field__label">Format</span>
          <select
            className="field__input"
            value={preset}
            onChange={(changed) => setPreset(changed.target.value)}
          >
            <option value="">Every format</option>
            {/* Taken from the log, so a format that has since been retired is
                still selectable for the history that mentions it. */}
            {summary.byPreset.map((count) => (
              <option key={count.key} value={count.key}>
                {count.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field field--inline">
          <span className="field__label">Period</span>
          <select
            className="field__input"
            value={period}
            onChange={(changed) => setPeriod(changed.target.value)}
          >
            {PERIODS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <button
          className="button button--quiet"
          type="button"
          disabled={busy}
          onClick={() => void load()}
        >
          {busy ? "Reading…" : "Refresh"}
        </button>
      </div>

      {history.events.length === 0 ? (
        <p className="muted">
          {history.matched === 0 && summary.total === 0
            ? "Nothing has been delivered to this destination yet."
            : "No deliveries match these filters."}
        </p>
      ) : (
        <>
          <p className="muted">
            Showing {history.events.length} of {history.matched} matching
            deliver{history.matched === 1 ? "y" : "ies"}, newest first.
          </p>
          <ul className="history__list">
            {history.events.map((event) => (
              <HistoryRow
                key={event.eventId}
                event={event}
                redelivered={repeats.has(event.eventId)}
              />
            ))}
          </ul>
        </>
      )}

      <div className="form__actions">
        <button
          className="button button--quiet"
          type="button"
          disabled={busy}
          title="Append events for deliveries whose receipts exist but were never recorded"
          onClick={() => void reconcile()}
        >
          Reconcile with receipts
        </button>
      </div>

      {reconciled === null ? null : (
        <p className="muted">
          {reconciled.problem ??
            `${reconciled.scanned} receipt${reconciled.scanned === 1 ? "" : "s"} examined · ` +
              `${reconciled.appended.length} appended · ` +
              `${reconciled.alreadyRecorded} already recorded` +
              (reconciled.unreconcilable.length > 0
                ? ` · ${reconciled.unreconcilable.length} could not be reconstructed`
                : "")}
        </p>
      )}
    </div>
  );
};

/**
 * The last few deliveries of one track, for its own panel.
 *
 * Answers "when did I last ship this?" without opening the global view, and
 * deliberately does not repeat its filters or its summary.
 */
export const TrackDeliveryHistory: React.FC<{ readonly slug: string }> = ({
  slug,
}) => {
  const [history, setHistory] = useState<DeliveryHistoryView | null>(null);

  useEffect(() => {
    let current = true;

    void getDeliveryHistory({ track: slug, limit: 5 })
      .then((result) => {
        if (current) setHistory(result);
      })
      // A history that cannot be read says nothing about what is delivered, so
      // it is left out rather than shown as an error in the delivery section.
      .catch(() => undefined);

    return () => {
      current = false;
    };
  }, [slug]);

  if (history === null || history.root === null) return null;

  // A damaged log must not look like a complete answer here either, even
  // though this view is only ever a few rows of one track. It says so briefly
  // and points at the full view, which carries the explanation.
  const damage =
    history.status === "complete" || history.status === "missing" ? null : (
      <p className="note note--warning">
        <span className="note__message">
          {DELIVERY_LOG_STATUS_NOTES[history.status] ??
            "The delivery log could not be read in full."}{" "}
          These rows may be incomplete.
        </span>
      </p>
    );

  // The label lives here rather than in the section, so nothing is left
  // hanging above an empty list when there is no destination to read.
  const label = (
    <p className="exports__intent">
      <span className="exports__intentlabel">Recent</span>
      <span className="muted">
        {history.events.length === 0
          ? history.status === "missing"
            ? "nothing delivered from here yet"
            : "no deliveries of this track are recorded"
          : `last ${history.events.length} deliver${history.events.length === 1 ? "y" : "ies"}`}
      </span>
    </p>
  );

  if (history.events.length === 0) {
    return (
      <>
        {label}
        {damage}
      </>
    );
  }

  const repeats = new Set(history.redelivered);

  return (
    <>
      {label}
      {damage}
      <ul className="history__list history__list--compact">
        {history.events.map((event) => (
          <HistoryRow
            key={event.eventId}
            event={event}
            redelivered={repeats.has(event.eventId)}
          />
        ))}
      </ul>
    </>
  );
};
