import { useState } from "react";
import type {
  RenderBatchView,
  RenderJobView,
} from "../../core/domain/api/views.ts";
import { RENDER_PRESETS } from "../../core/domain/video/renderPresets.ts";
import {
  ApiRequestError,
  cancelRender,
  cancelRenderBatch,
  revealTrackOutput,
} from "../api/client.ts";
import { useRenderBatch } from "../hooks/useRenderBatch.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

const ACTIVE_STATUSES = ["queued", "preparing", "rendering"] as const;

const isActive = (job: RenderJobView): boolean =>
  (ACTIVE_STATUSES as readonly string[]).includes(job.status);

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

const formatElapsed = (ms: number): string => {
  const total = Math.floor(ms / 1000);

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
};

/**
 * One line per queued render.
 *
 * Progress and frame counts are the job's own, straight from Remotion. The
 * phase is shown as the primary signal because each render spends its first
 * stretch decoding audio, when progress legitimately sits near zero.
 */
const JobRow: React.FC<{
  readonly job: RenderJobView;
  readonly onChanged: () => void;
}> = ({ job, onChanged }) => {
  const [busy, setBusy] = useState(false);
  const percent = Math.round(job.progress * 100);

  const act = async (run: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await run();
      onChanged();
    } catch {
      // Row-level failures are transient — the batch view re-reports the truth.
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="queue__row">
      <span className={`badge badge--job-${job.status}`}>{job.status}</span>

      <span className="queue__track" title={job.slug}>
        {job.slug}
      </span>

      <span className="queue__preset">
        {RENDER_PRESETS[job.presetId].shortLabel}
      </span>

      <span className="queue__bar">
        <span className="progress">
          <span
            className="progress__fill"
            style={{ width: `${isActive(job) || job.status === "completed" ? percent : 0}%` }}
          />
        </span>
      </span>

      <span className="queue__numbers">
        {percent}%
        {job.totalFrames !== null
          ? ` · ${job.framesRendered ?? 0}/${job.totalFrames}`
          : ""}
      </span>

      <span className="queue__elapsed">{formatElapsed(job.elapsedMs)}</span>

      <span className="queue__output">
        {job.status === "completed" && job.outputLabel ? (
          <button
            className="button button--quiet button--tiny"
            type="button"
            disabled={busy}
            title={job.outputPath ?? undefined}
            onClick={() => void act(() => revealTrackOutput(job.slug, job.presetId))}
          >
            Show
          </button>
        ) : job.error ? (
          <span className="queue__error" title={job.error.message}>
            {job.error.code}
          </span>
        ) : isActive(job) ? (
          <button
            className="button button--quiet button--tiny"
            type="button"
            disabled={busy}
            onClick={() => void act(() => cancelRender(job.id))}
          >
            Cancel
          </button>
        ) : (
          <span className="muted">—</span>
        )}
      </span>
    </li>
  );
};

/**
 * The render queue, shown only while a batch is being followed.
 *
 * Batch state is the server's; this panel subscribes rather than counting
 * anything itself, so a reload or a second tab sees the same numbers.
 */
export const QueueDrawer: React.FC<{
  readonly batchId: string | null;
  readonly onChanged: () => void;
  readonly onDismiss: () => void;
}> = ({ batchId, onChanged, onDismiss }) => {
  const [error, setError] = useState<ApiRequestError | null>(null);
  const { batch, missing } = useRenderBatch(batchId, onChanged);

  if (batchId === null) {
    return null;
  }

  const summary = (current: RenderBatchView): string =>
    [
      `${current.totalJobs} total`,
      current.completed > 0 ? `${current.completed} complete` : null,
      current.active > 0 ? `${current.active} rendering` : null,
      current.queued > 0 ? `${current.queued} queued` : null,
      current.failed > 0 ? `${current.failed} failed` : null,
      current.cancelled > 0 ? `${current.cancelled} cancelled` : null,
    ]
      .filter((part) => part !== null)
      .join(" · ");

  return (
    <section className="queue" aria-label="Render queue">
      <header className="queue__head">
        <h2 className="queue__title">Render queue</h2>

        {batch ? (
          <>
            <span className="queue__summary">{summary(batch)}</span>
            <span className="queue__bar queue__bar--total">
              <span className="progress">
                <span
                  className="progress__fill"
                  style={{ width: `${Math.round(batch.progress * 100)}%` }}
                />
              </span>
            </span>
            <span className="actions__result">
              {Math.round(batch.progress * 100)}%
            </span>
          </>
        ) : (
          <span className="queue__summary muted">
            {missing ? "This batch is no longer known to the server." : "Loading…"}
          </span>
        )}

        <span className="app__spacer" />

        {batch && batch.status === "running" ? (
          <button
            className="button button--quiet"
            type="button"
            onClick={() => {
              setError(null);
              void cancelRenderBatch(batch.id)
                .then(onChanged)
                .catch((cause: unknown) => setError(asApiError(cause)));
            }}
          >
            Cancel all
          </button>
        ) : (
          <button className="button button--quiet" type="button" onClick={onDismiss}>
            Close
          </button>
        )}
      </header>

      {error ? <ErrorBanner error={error} title="Could not cancel" /> : null}

      {batch ? (
        <ul className="queue__rows">
          {batch.jobs.map((job) => (
            <JobRow key={job.id} job={job} onChanged={onChanged} />
          ))}
        </ul>
      ) : null}
    </section>
  );
};
