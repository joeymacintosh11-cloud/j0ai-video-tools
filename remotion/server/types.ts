import type { TrackErrorCode } from "../src/domain/tracks/errors.ts";

export type RenderJobStatus =
  | "queued"
  | "preparing"
  | "rendering"
  | "completed"
  | "failed"
  | "cancelled";

export const TERMINAL_STATUSES: readonly RenderJobStatus[] = [
  "completed",
  "failed",
  "cancelled",
];

export const isTerminalStatus = (status: RenderJobStatus): boolean =>
  TERMINAL_STATUSES.includes(status);

export type RenderJobLogEntry = {
  readonly at: string;
  readonly level: "info" | "error";
  readonly message: string;
};

export type RenderJobError = {
  readonly code: TrackErrorCode | "INTERNAL_ERROR";
  readonly message: string;
  readonly path?: string;
  /** Technical detail for debugging; never the only thing reported. */
  readonly details?: string;
};

/** Serialized job state, as returned by the API. */
export type RenderJobView = {
  readonly id: string;
  readonly slug: string;
  readonly status: RenderJobStatus;
  readonly progress: number;
  readonly framesRendered: number | null;
  readonly totalFrames: number | null;
  readonly fps: number | null;
  readonly elapsedMs: number;
  readonly startedAt: string | null;
  readonly queuedAt: string;
  readonly finishedAt: string | null;
  readonly outputPath: string | null;
  readonly outputLabel: string | null;
  readonly error: RenderJobError | null;
};

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
