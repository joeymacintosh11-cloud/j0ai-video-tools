import type {
  RenderJobError,
  RenderJobStatus,
} from "../src/domain/api/views.ts";

/**
 * Server-internal types.
 *
 * The API's wire format lives in src/domain/api/views.ts so the UI can share
 * it. What stays here is what only the server needs: the terminal-status
 * helpers and the parent/worker IPC protocol, which is not part of the API.
 */

export type {
  RenderJobError,
  RenderJobLogEntry,
  RenderJobStatus,
  RenderJobView,
} from "../src/domain/api/views.ts";

export const TERMINAL_STATUSES: readonly RenderJobStatus[] = [
  "completed",
  "failed",
  "cancelled",
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
