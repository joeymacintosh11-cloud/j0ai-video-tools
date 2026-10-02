import type {
  RenderJobError,
  RenderJobStatus,
} from "../../core/domain/api/views.ts";

/**
 * Render-job types shared by the render manager, its worker and their callers
 * (the API server and the CLI).
 *
 * The API's wire format lives in core/domain/api/views.ts so the UI can share
 * it. What lives here is not part of the API: the terminal-status helpers and
 * the parent/worker IPC protocol.
 */

export type {
  RenderJobError,
  RenderJobLogEntry,
  RenderJobStatus,
  RenderJobView,
} from "../../core/domain/api/views.ts";

export const TERMINAL_STATUSES: readonly RenderJobStatus[] = [
  "completed",
  "failed",
  "cancelled",
  // Not a state the render manager ever assigns live — see RenderJobStatus's
  // own comment — but a historical "interrupted" answer must be just as
  // final to every caller that only checks isTerminalStatus(): no SSE retry,
  // no cancel attempt, no ghost spinner.
  "interrupted",
];

export const isTerminalStatus = (status: RenderJobStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

/* ------------------------------------------------------------------ *
 * Worker IPC protocol
 * ------------------------------------------------------------------ */

export type WorkerEvent =
  | { readonly type: "log"; readonly level: "info" | "error"; readonly message: string }
  | { readonly type: "status"; readonly status: "preparing" | "rendering" }
  | {
      readonly type: "resolved";
      readonly durationInFrames: number;
      readonly fps: number;
      readonly outputPath: string;
      readonly outputLabel: string;
    }
  | {
      readonly type: "progress";
      readonly progress: number;
      readonly renderedFrames: number;
      readonly encodedFrames: number;
      readonly stitchStage: string;
    }
  | {
      readonly type: "done";
      readonly outputPath: string;
      readonly outputLabel: string;
    }
  | { readonly type: "cancelled" }
  | { readonly type: "error"; readonly error: RenderJobError };

export type WorkerCommand = { readonly type: "cancel" };
