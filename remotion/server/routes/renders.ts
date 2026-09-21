import type { ServerResponse } from "node:http";
import type { RenderJobView, RenderLogsView } from "../../src/domain/api/views.ts";
import { TrackError } from "../../src/domain/tracks/errors.ts";
import { sendOk } from "../http/json.ts";
import { openSseStream } from "../http/sse.ts";
import { getHistoricalRenderJob } from "../services/renderJournal.ts";
import { renderManager } from "../services/renderManager.ts";
import { isTerminalStatus } from "../types.ts";

/**
 * A view built from the durable journal rather than from a live job.
 *
 * Deliberately sparse next to `renderManager.toView()`'s output: the journal
 * never recorded progress, frame counts, fps, timing detail or output paths
 * (see src/domain/render/renderJournal.ts's own comment on why it stays
 * narrow), so this reports only what is actually known rather than padding
 * the shape with fabricated zeros. `elapsedMs` is 0 for the same reason —
 * there is no live clock to measure against any more.
 */
const historicalView = (jobId: string): RenderJobView | null => {
  const recovered = getHistoricalRenderJob(jobId);
  if (recovered === null) return null;

  return {
    id: recovered.jobId,
    slug: recovered.slug,
    presetId: recovered.presetId as RenderJobView["presetId"],
    batchId: recovered.batchId,
    status: recovered.status,
    progress: 0,
    framesRendered: null,
    totalFrames: null,
    fps: null,
    elapsedMs: 0,
    startedAt: null,
    queuedAt: recovered.recordedAt,
    finishedAt: recovered.status === "interrupted" ? null : recovered.recordedAt,
    outputPath: null,
    outputLabel: null,
    // The journal only ever records what was already a real job.error at
    // write time, whose code was already a valid TrackErrorCode — the
    // domain journal type just does not import that whole union to stay
    // decoupled from it (src/domain/render/renderJournal.ts).
    error: recovered.error as RenderJobView["error"],
    historical: true,
    recoveredAfterRestart: recovered.recoveredAfterRestart,
  };
};

/**
 * Live authority always wins (§17 of the milestone this implements): the
 * journal is only ever consulted once `renderManager` itself has said a job
 * id is not one it currently holds. A journal entry can therefore never
 * shadow or downgrade a job that is genuinely still running.
 */
const getJobOrHistorical = (jobId: string): RenderJobView => {
  try {
    return renderManager.getJob(jobId);
  } catch (error) {
    if (!(error instanceof TrackError) || error.code !== "RENDER_JOB_NOT_FOUND") throw error;

    const historical = historicalView(jobId);
    if (historical !== null) return historical;

    throw error;
  }
};

export const handleListRenders = (response: ServerResponse): void => {
  sendOk(response, renderManager.listJobs());
};

export const handleGetRender = (
  jobId: string,
  response: ServerResponse,
): void => {
  sendOk(response, getJobOrHistorical(jobId));
};

export const handleGetRenderLogs = (
  jobId: string,
  response: ServerResponse,
): void => {
  const job = renderManager.getJob(jobId);

  const payload: RenderLogsView = {
    id: job.id,
    slug: job.slug,
    status: job.status,
    logs: renderManager.getLogs(jobId),
  };

  sendOk(response, payload);
};

export const handleCancelRender = (
  jobId: string,
  response: ServerResponse,
): void => {
  sendOk(response, renderManager.cancelRender(jobId));
};

/**
 * Streams a job's real progress as Server-Sent Events.
 *
 * The current state is replayed immediately on connect (so a late subscriber
 * isn't stuck at 0%), and the stream closes itself once the job reaches a
 * terminal state.
 */
export const handleRenderEvents = (
  jobId: string,
  response: ServerResponse,
): void => {
  // Throws RENDER_JOB_NOT_FOUND before any SSE headers are written.
  const initialJob = renderManager.getJob(jobId);

  const stream = openSseStream(response);

  stream.send("status", initialJob);
  for (const entry of renderManager.getLogs(jobId)) {
    stream.send("log", entry);
  }

  if (isTerminalStatus(initialJob.status)) {
    stream.send(
      initialJob.status === "completed"
        ? "completed"
        : initialJob.status === "cancelled"
          ? "cancelled"
          : "failed",
      initialJob,
    );
    stream.close();
    return;
  }

  const unsubscribe = renderManager.subscribe(jobId, (event) => {
    if (event.type === "log") {
      stream.send("log", event.entry);
      return;
    }

    stream.send(event.type, event.job);

    if (isTerminalStatus(event.job.status)) {
      stream.close();
    }
  });

  stream.onClose(unsubscribe);

  // A terminal transition at the replay/subscribe boundary must be visible
  // even if its event was emitted before this listener was registered.
  const current = renderManager.getJob(jobId);
  if (isTerminalStatus(current.status)) {
    stream.send(
      current.status === "completed" ? "completed" : current.status === "cancelled" ? "cancelled" : "failed",
      current,
    );
    stream.close();
  }
};
