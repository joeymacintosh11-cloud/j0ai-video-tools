import type { IncomingMessage, ServerResponse } from "node:http";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";

const MAX_BODY_BYTES = 256 * 1024;

export const sendJson = (
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void => {
  const body = JSON.stringify(payload, null, 2);

  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
};

export const sendOk = (response: ServerResponse, data: unknown): void => {
  sendJson(response, 200, { ok: true, data });
};

/**
 * Reads and parses a JSON request body. Bodies are small by design in this
 * phase (no uploads), so anything oversized is rejected outright rather than
 * streamed.
 */
export const readJsonBody = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;

    if (total > MAX_BODY_BYTES) {
      throw new TrackError(
        trackIssue("INVALID_REQUEST", "Request body is too large."),
      );
    }

    chunks.push(buffer);
  }

  if (total === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TrackError(
      trackIssue("INVALID_REQUEST", `Request body is not valid JSON: ${reason}`),
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Request body must be a JSON object."),
    );
  }

  return parsed as Record<string, unknown>;
};
