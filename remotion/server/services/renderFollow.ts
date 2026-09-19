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
  // Fast path for a job that was terminal before this call began. The state is
  // checked again after subscribing, closing the read/subscribe boundary.
  const initial = renderManager.getJob(jobId);
  if (isTerminalStatus(initial.status)) {
    return Promise.resolve({ outcome: "settled", job: initial });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let unsubscribe = () => {};

    const finish = (result: FollowRenderJobResult) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      unsubscribe();
      resolve(result);
    };

    unsubscribe = renderManager.subscribe(jobId, (event) => {
      if (event.type === "completed" || event.type === "failed" || event.type === "cancelled") {
        finish({ outcome: "settled", job: event.job });
      }
    });

    // A test hook or future subscribe implementation may synchronously emit
    // while registering. In that case finish ran before unsubscribe existed;
    // remove the listener now. Otherwise re-read authoritative state to catch
    // a terminal transition at the subscription boundary.
    if (settled) {
      unsubscribe();
      return;
    }
    let current: RenderJobView;
    try {
      current = renderManager.getJob(jobId);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    if (isTerminalStatus(current.status)) {
      finish({ outcome: "settled", job: current });
      return;
    }

    timer = setTimeout(() => {
      const job = renderManager.getJob(jobId);
      finish(isTerminalStatus(job.status)
        ? { outcome: "settled", job }
        : { outcome: "timed_out", job });
    }, timeoutMs);
  });
};
