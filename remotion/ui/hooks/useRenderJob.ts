import { useEffect, useRef, useState } from "react";
import type {
  RenderJobLogEntry,
  RenderJobView,
} from "../../src/domain/api/views.ts";
import { ApiRequestError, getRender, getRenderLogs, renderEventsUrl } from "../api/client.ts";

/**
 * Follows one render job over Server-Sent Events.
 *
 * The server replays the job's current status and its whole log buffer on
 * connect, so this does not need to fetch anything first and a page reload
 * mid-render picks up where it left off. Progress numbers come straight from
 * Remotion — nothing here interpolates or synthesizes them.
 *
 * Job records live in the server's memory, so a server restart loses them. A
 * job that has vanished is reported as gone rather than left on a stuck bar.
 */

export type RenderJobState = {
  readonly job: RenderJobView | null;
  readonly logs: readonly RenderJobLogEntry[];
  /** Set when the job id is no longer known to the server. */
  readonly missing: boolean;
};

const MAX_LOGS = 200;

export const useRenderJob = (
  jobId: string | null,
  onFinished: () => void,
  loadLogs = true,
): RenderJobState => {
  const [job, setJob] = useState<RenderJobView | null>(null);
  const [logs, setLogs] = useState<readonly RenderJobLogEntry[]>([]);
  const [missing, setMissing] = useState(false);

  // Kept in a ref so reconnecting is not triggered by the callback changing.
  const finishedRef = useRef(onFinished);
  finishedRef.current = onFinished;
  const notifiedJobRef = useRef<string | null>(null);

  useEffect(() => {
    if (jobId === null) {
      setJob(null);
      setLogs([]);
      setMissing(false);
      return;
    }

    let cancelled = false;
    setJob(null);
    setLogs([]);
    setMissing(false);
    notifiedJobRef.current = null;

    const notifyFinished = () => {
      if (notifiedJobRef.current === jobId) return;
      notifiedJobRef.current = jobId;
      finishedRef.current();
    };

    const source = new EventSource(renderEventsUrl(jobId));

    const onJob = (event: MessageEvent<string>) => {
      if (cancelled) return;
      setJob(JSON.parse(event.data) as RenderJobView);
    };

    const onTerminal = (event: MessageEvent<string>) => {
      if (cancelled) return;
      setJob(JSON.parse(event.data) as RenderJobView);
      notifyFinished();
      source.close();
    };

    source.addEventListener("status", onJob);
    source.addEventListener("progress", onJob);
    source.addEventListener("completed", onTerminal);
    source.addEventListener("failed", onTerminal);
    source.addEventListener("cancelled", onTerminal);

    source.addEventListener("log", (event: MessageEvent<string>) => {
      if (cancelled || !loadLogs) return;
      const entry = JSON.parse(event.data) as RenderJobLogEntry;

      setLogs((previous) => [...previous, entry].slice(-MAX_LOGS));
    });

    // EventSource retries on its own, which is wrong for a job that no longer
    // exists. Ask the API once: if the job is genuinely gone, stop.
    source.addEventListener("error", () => {
      void getRender(jobId)
        .then((current) => {
          if (cancelled) return;
          setJob(current);
          // "interrupted" included: a job the journal now answers for
          // historically is exactly as final as any other terminal state —
          // retrying the stream would only reconnect to nothing.
          if (
            current.status === "completed" ||
            current.status === "failed" ||
            current.status === "cancelled" ||
            current.status === "interrupted"
          ) {
            notifyFinished();
            source.close();
          }
        })
        .catch((cause: unknown) => {
          if (cancelled) return;
          // A temporary transport/API failure is not a missing render job.
          // EventSource reconnects automatically; only an authoritative 404
          // means the server has forgotten this in-memory job.
          if (cause instanceof ApiRequestError && cause.status === 404) {
            setMissing(true);
            source.close();
          }
        });
    });

    // Seed the log panel for a job that finished before this mounted, where
    // there is no live stream left to replay from.
    if (loadLogs) {
      void getRenderLogs(jobId)
        .then((snapshot) => {
          if (cancelled) return;
          setLogs((previous) =>
            previous.length === 0 ? snapshot.logs : previous,
          );
        })
        .catch(() => undefined);
    }

    return () => {
      cancelled = true;
      source.close();
    };
  }, [jobId, loadLogs]);

  return { job, logs, missing };
};
