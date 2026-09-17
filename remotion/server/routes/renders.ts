import type { ServerResponse } from "node:http";
import { sendOk } from "../http/json.ts";
import { openSseStream } from "../http/sse.ts";
import { renderManager } from "../services/renderManager.ts";
import { isTerminalStatus } from "../types.ts";

export const handleListRenders = (response: ServerResponse): void => {
  sendOk(response, renderManager.listJobs());
};

export const handleGetRender = (
  jobId: string,
  response: ServerResponse,
): void => {
  sendOk(response, renderManager.getJob(jobId));
};

export const handleGetRenderLogs = (
  jobId: string,
  response: ServerResponse,
): void => {
  const job = renderManager.getJob(jobId);

  sendOk(response, {
    id: job.id,
    slug: job.slug,
    status: job.status,
    logs: renderManager.getLogs(jobId),
  });
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
};
