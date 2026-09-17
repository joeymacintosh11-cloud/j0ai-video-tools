import { useEffect, useRef, useState } from "react";
import type {
  RenderJobStatus,
  TrackDetailView,
} from "../../src/domain/api/views.ts";
import {
  ApiRequestError,
  cancelRender,
  listRenders,
  revealTrackOutput,
  startRender,
} from "../api/client.ts";
import { useRenderJob } from "../hooks/useRenderJob.ts";
import { useStillCurrent } from "../hooks/useStillCurrent.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

const ACTIVE: readonly RenderJobStatus[] = ["queued", "preparing", "rendering"];

/**
 * Each of the three render workers decodes the analysis audio once before its
 * first frame lands, so progress legitimately sits near zero for a while at the
 * start. The phase is shown as the primary signal and the bar as secondary, so
 * that window does not read as a stuck render.
 */
const PHASE_TEXT: Record<RenderJobStatus, string> = {
  queued: "Queued — waiting for the render slot",
  preparing: "Preparing — bundling and decoding audio",
  rendering: "Rendering frames",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

const formatElapsed = (ms: number): string => {
  const total = Math.floor(ms / 1000);

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

export const RenderPanel: React.FC<{
  readonly track: TrackDetailView;
  readonly onChanged: () => void;
}> = ({ track, onChanged }) => {
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);

  const { job, logs, missing } = useRenderJob(jobId, onChanged);
  const stillCurrent = useStillCurrent(track.slug);

  // Drop the followed job when switching tracks, so one track's render does not
  // appear under another — then recover the real state from the server.
  //
  // Which render is running is the server's knowledge, not this component's. A
  // reload, a track switch, or a second browser tab would otherwise leave the
  // panel offering "Render" for a track that is already rendering, so it asks
  // and re-attaches to the job in flight instead.
  useEffect(() => {
    const slug = track.slug;
    let abandoned = false;

    setJobId(null);
    setError(null);
    setBusy(false);

    void listRenders()
      .then((jobs) => {
        if (abandoned) {
          return;
        }
        const active = jobs.find(
          (candidate) =>
            candidate.slug === slug && ACTIVE.includes(candidate.status),
        );
        if (active) {
          setJobId(active.id);
        }
      })
      .catch(() => undefined);

    return () => {
      abandoned = true;
    };
  }, [track.slug]);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ block: "end" });
  }, [logs.length]);

  const active = job !== null && ACTIVE.includes(job.status);

  const begin = async () => {
    const slug = track.slug;

    setBusy(true);
    setError(null);

    try {
      const started = await startRender(slug);

      if (stillCurrent(slug)) {
        setJobId(started.jobId);
      }
    } catch (cause) {
      const failure = asApiError(cause);

      // The server refuses a second render of the same track. That means one is
      // already running — adopt it rather than reporting a failure the user
      // cannot act on.
      if (failure.code === "RENDER_ALREADY_ACTIVE") {
        const jobs = await listRenders().catch(() => []);
        const active = jobs.find(
          (candidate) =>
            candidate.slug === slug && ACTIVE.includes(candidate.status),
        );

        if (stillCurrent(slug) && active) {
          setJobId(active.id);
          return;
        }
      }

      if (stillCurrent(slug)) {
        setError(failure);
      }
    } finally {
      if (stillCurrent(slug)) {
        setBusy(false);
      }
    }
  };

  const reveal = async () => {
    const slug = track.slug;

    setError(null);

    try {
      await revealTrackOutput(slug);
    } catch (cause) {
      if (stillCurrent(slug)) {
        setError(asApiError(cause));
      }
    }
  };

  const stop = async () => {
    if (jobId === null) {
      return;
    }

    const slug = track.slug;

    setBusy(true);
    setError(null);

    try {
      await cancelRender(jobId);
    } catch (cause) {
      if (stillCurrent(slug)) {
        setError(asApiError(cause));
      }
    } finally {
      if (stillCurrent(slug)) {
        setBusy(false);
      }
    }
  };

  const percent = job ? Math.round(job.progress * 100) : 0;

  return (
    <div className="render">
      {error ? <ErrorBanner error={error} title="Render request failed" /> : null}

      <div className="form__actions">
        <button
          className="button"
          type="button"
          disabled={busy || active || !track.validation.ok}
          title={
            track.validation.ok
              ? "Render this track to out/"
              : "Fix the problems below before rendering"
          }
          onClick={() => void begin()}
        >
          {active ? "Rendering…" : "Render"}
        </button>

        {active ? (
          <button
            className="button button--quiet"
            type="button"
            disabled={busy}
            onClick={() => void stop()}
          >
            Cancel
          </button>
        ) : null}

        {track.render.present && !active ? (
          <>
            <button
              className="button button--quiet"
              type="button"
              disabled={busy}
              title={track.render.outputPath ?? undefined}
              onClick={() => void reveal()}
            >
              Show in Finder
            </button>
            <span className="actions__result">{track.render.outputLabel}</span>
          </>
        ) : null}
      </div>

      {missing ? (
        <p className="muted">
          That render job is no longer known to the server — job history is kept
          in memory and is lost when the server restarts. Any finished video is
          still on disk.
        </p>
      ) : null}

      {job ? (
        <div className="render__status">
          <div className="render__phase">
            <span className={`badge badge--job-${job.status}`}>
              {job.status}
            </span>
            <span>{PHASE_TEXT[job.status]}</span>
            <span className="app__spacer" />
            <span className="actions__result">
              {formatElapsed(job.elapsedMs)}
            </span>
          </div>

          <div className="progress">
            <div className="progress__fill" style={{ width: `${percent}%` }} />
          </div>

          <div className="render__numbers">
            <span>{percent}%</span>
            {job.totalFrames !== null ? (
              <span>
                {job.framesRendered ?? 0} / {job.totalFrames} frames
              </span>
            ) : null}
            {job.outputLabel ? <span>{job.outputLabel}</span> : null}
          </div>

          {job.error ? (
            <div className="banner" role="alert">
              <div className="banner__title">Render failed</div>
              <div className="banner__message">{job.error.message}</div>
              <div className="banner__code">{job.error.code}</div>
            </div>
          ) : null}
        </div>
      ) : null}

      {logs.length > 0 ? (
        <div className="logs">
          {logs.map((entry, index) => (
            <div
              key={`${entry.at}-${index}`}
              className={`logs__line logs__line--${entry.level}`}
            >
              <span className="logs__time">{entry.at.slice(11, 19)}</span>
              {entry.message}
            </div>
          ))}
          <div ref={logEndRef} />
        </div>
      ) : null}
    </div>
  );
};
