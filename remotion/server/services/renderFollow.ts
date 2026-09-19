import type { RenderJobView } from "../../src/domain/api/views.ts";
import { isTerminalStatus } from "../types.ts";
import { renderManager } from "./renderManager.ts";

/**
 * Waits for one render job to reach a terminal state, bounded by a timeout.
 *
 * Built entirely on the render manager's own event subscription — no
 * polling, no new watcher, no second queue, no persisted wait state. A
 * timeout never cancels the job: it only means this particular call gave up
 * watching before a final result arrived. The job itself is untouched and
 * keeps running exactly as it would have with nobody waiting on it, which is
 * the whole point of `timed_out` being a distinct outcome from `failed`.
 */

export type FollowRenderJobResult =
  | { readonly outcome: "settled"; readonly job: RenderJobView }
  | { readonly outcome: "timed_out"; readonly job: RenderJobView };

export const followRenderJob = (
  jobId: string,
  timeoutMs: number,
): Promise<FollowRenderJobResult> => {
  // Checked synchronously before subscribing, so a job that already settled
  // (a very fast render, or one this call adopted after it finished) is
  // reported immediately rather than waiting on events that already fired.
  const initial = renderManager.getJob(jobId);
  if (isTerminalStatus(initial.status)) {
    return Promise.resolve({ outcome: "settled", job: initial });
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: FollowRenderJobResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = renderManager.subscribe(jobId, (event) => {
      if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
        finish({ outcome: "settled", job: event.job });
      }
    });

    const timer = setTimeout(() => {
      finish({ outcome: "timed_out", job: renderManager.getJob(jobId) });
    }, timeoutMs);
  });
};
