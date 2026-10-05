import type { ServerResponse } from "node:http";
import {
  TrackError,
  type TrackErrorCode,
  type TrackIssue,
} from "../../core/domain/tracks/errors.ts";
import { sendJson } from "./json.ts";

const STATUS_BY_CODE: Record<TrackErrorCode, number> = {
  TRACK_NOT_FOUND: 404,
  TRACK_ALREADY_EXISTS: 409,
  INVALID_TRACK_NAME: 400,
  INVALID_SLUG: 400,
  INVALID_REQUEST: 400,
  INVALID_PRESET: 400,
  INVALID_RENDERER: 400,
  RENDERER_UNAVAILABLE: 400,
  RENDERER_NOT_CONFIGURED: 400,
  RENDERER_NOT_SUPPORTED: 400,
  INVALID_PLATFORM: 400,
  TEMPLATE_INVALID: 400,
  TEMPLATE_CONFLICT: 412,
  COVER_MISSING: 400,
  AUDIO_MISSING: 400,
  METADATA_MISSING: 400,
  METADATA_INVALID: 400,
  METADATA_WRITE_FAILED: 500,
  METADATA_CONFLICT: 412,
  UPLOAD_INVALID: 400,
  UPLOAD_TOO_LARGE: 413,
  UPLOAD_FAILED: 500,
  REVEAL_FAILED: 500,
  ANALYSIS_STALE: 400,
  FFMPEG_NOT_FOUND: 500,
  ANALYSIS_GENERATION_FAILED: 500,
  RENDER_FAILED: 500,
  RENDER_JOB_NOT_FOUND: 404,
  RENDER_BATCH_NOT_FOUND: 404,
  RENDER_NOT_CANCELLABLE: 409,
  RENDER_ALREADY_ACTIVE: 409,
  RENDER_TARGET_LOCKED: 409,
  LIBRARY_RECORD_NOT_FOUND: 404,
  LIBRARY_RECORD_NOT_CURRENT: 409,
  PUBLISH_DESTINATION_UNKNOWN: 400,
  PUBLISH_JOB_NOT_FOUND: 404,
  PUBLISH_JOB_CONFLICT: 409,
};

export const statusForCode = (code: TrackErrorCode): number =>
  STATUS_BY_CODE[code] ?? 500;

export type ErrorBody = {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly path?: string;
    /** Only present for unexpected failures, to aid debugging. */
    readonly details?: string;
  };
};

export const errorBodyFromIssue = (issue: TrackIssue): ErrorBody => ({
  ok: false,
  error: { code: issue.code, message: issue.message, path: issue.path },
});

export const sendError = (
  response: ServerResponse,
  statusCode: number,
  body: ErrorBody,
): void => {
  sendJson(response, statusCode, body);
};

export const sendNotFound = (response: ServerResponse, what: string): void => {
  sendError(response, 404, {
    ok: false,
    error: { code: "NOT_FOUND", message: `${what} not found.` },
  });
};

/**
 * Maps the shared domain error model onto HTTP. Expected failures (TrackError)
 * become their mapped status with a clean message; anything else is a bug and
 * becomes a 500 with a friendly message plus technical details, never a bare
 * stack trace as the only information.
 */
export const sendErrorForException = (
  response: ServerResponse,
  error: unknown,
  context: string,
): void => {
  if (error instanceof TrackError) {
    sendError(response, statusForCode(error.code), errorBodyFromIssue(error.issue));
    return;
  }

  const details = error instanceof Error ? (error.stack ?? error.message) : String(error);
  console.error(`[api] unexpected error while ${context}:`, error);

  sendError(response, 500, {
    ok: false,
    error: {
      code: "INTERNAL_ERROR",
      message: `Something went wrong while ${context}.`,
      details,
    },
  });
};
