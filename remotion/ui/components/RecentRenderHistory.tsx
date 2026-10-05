import { useEffect, useState } from "react";
import type {
  RenderHistoryJobView,
  RenderHistoryView,
} from "../../core/domain/api/views.ts";
import { formatRecentRenderTimestamp } from "../../core/domain/render/renderJournal.ts";
import { RENDERER_LABELS } from "../../core/domain/video/renderers.ts";
import { RENDER_PRESETS } from "../../core/domain/video/renderPresets.ts";
import { getRenderHistory } from "../api/client.ts";

/**
 * "What happened to this track's most recent renders?" — a small,
 * observation-only surface over the durable render journal
 * (core/domain/render/renderJournal.ts), for one track's own TrackDetail.
 *
 * Deliberately narrow, per the milestone brief this implements: no history
 * page, no job management, no cancel/retry, nothing that could be mistaken
 * for a second readiness or queue authority. Every badge here is a
 * *historical* terminal state — completed/failed/cancelled/interrupted —
 * never queued/preparing/rendering, so nothing here can be confused with the
 * live render state `RenderPanel` already shows elsewhere on this page. This
 * component does not subscribe to SSE and does not poll; it fetches when the
 * slug or caller’s refreshed track snapshot changes.
 * Completion/cancellation callbacks already refresh that snapshot, so history
 * follows settled jobs without adding a polling loop.
 */

const STATUS_TEXT: Record<RenderHistoryJobView["status"], string> = {
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  interrupted: "Interrupted by server restart",
};

const STATUS_TITLE: Partial<Record<RenderHistoryJobView["status"], string>> = {
  interrupted:
    "The server restarted before a terminal render result was recorded.",
};

const presetLabel = (presetId: RenderHistoryJobView["presetId"]): string =>
  RENDER_PRESETS[presetId]?.label ?? presetId;

const HistoryRow: React.FC<{ readonly job: RenderHistoryJobView }> = ({
  job,
}) => (
  <li
    className="recenthistory__row"
    aria-label={`${STATUS_TEXT[job.status]}, ${presetLabel(job.presetId)}`}
  >
    <span
      className={`badge badge--job-${job.status}`}
      title={STATUS_TITLE[job.status]}
    >
      {STATUS_TEXT[job.status]}
    </span>
    <span className="recenthistory__preset">
      {presetLabel(job.presetId)} ·{" "}
      {job.engine === null ? "Unknown renderer" : RENDERER_LABELS[job.engine]}
    </span>
    <span
      className="recenthistory__when"
      title={new Date(job.recordedAt).toISOString()}
    >
      {formatRecentRenderTimestamp(job.recordedAt)}
    </span>
    {job.error ? (
      <span className="recenthistory__error" title={job.error.code}>
        {job.error.message}
      </span>
    ) : null}
  </li>
);

export const TrackRecentRenderHistory: React.FC<{
  readonly slug: string;
  readonly refreshKey?: object;
}> = ({ slug, refreshKey }) => {
  const [history, setHistory] = useState<RenderHistoryView | null>(null);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    let current = true;
    setHistory(null);
    setUnavailable(false);

    void getRenderHistory(slug, 3)
      .then((result) => {
        if (current) setHistory(result);
      })
      .catch(() => {
        if (current) setUnavailable(true);
      });

    return () => {
      current = false;
    };
  }, [slug, refreshKey]);

  if (unavailable) {
    return (
      <div className="recenthistory">
        <p className="muted">Render history unavailable.</p>
      </div>
    );
  }

  if (history === null) {
    return (
      <div className="recenthistory">
        <p className="muted">Loading…</p>
      </div>
    );
  }

  // A journal read problem (a damaged or newer-schema file) is reported
  // alongside whatever history could still be recovered — never treated as
  // an error that hides the section, and never a reason to fabricate what
  // was not readable. See RENDER_JOURNAL_STATUS_NOTES.
  const damage =
    history.statusNote === null ? null : (
      <p className="note note--warning">
        <span className="note__message">{history.statusNote}</span>
      </p>
    );

  if (history.jobs.length === 0) {
    return (
      <div className="recenthistory">
        <p className="muted">No render history yet</p>
        {damage}
      </div>
    );
  }

  const [mostRecent, ...earlier] = history.jobs;

  return (
    <div className="recenthistory">
      {damage}
      <ul className="recenthistory__list" aria-label="Recent render history">
        <HistoryRow job={mostRecent} />
      </ul>
      {earlier.length > 0 ? (
        <>
          <p className="recenthistory__earlierlabel muted">Earlier</p>
          <ul className="recenthistory__list recenthistory__list--compact">
            {earlier.map((job) => (
              <HistoryRow key={job.jobId} job={job} />
            ))}
          </ul>
        </>
      ) : null}
      {/* A historical result is never current package/export truth — those
          are shown independently elsewhere on this page (Exports, Content
          package) and are never derived from this journal-backed history. */}
      <p className="recenthistory__note muted">
        Historical render result — current export and package readiness are
        shown separately above.
      </p>
    </div>
  );
};
