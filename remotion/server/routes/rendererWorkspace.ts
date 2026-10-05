import type { IncomingMessage, ServerResponse } from "node:http";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { rendererWorkspace } from "../../services/render/rendererWorkspace.ts";
import { readJsonBody, sendOk } from "../http/json.ts";

export const handleInspectWorkspace = async (
  response: ServerResponse,
): Promise<void> => {
  sendOk(response, await rendererWorkspace().inspect());
};
export const handleMaintainWorkspace = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  for (const key of ["dryRun", "prune"] as const) {
    if (body[key] !== undefined && typeof body[key] !== "boolean")
      throw new TrackError(
        trackIssue("INVALID_REQUEST", `${key} must be true or false.`),
      );
  }
  if (
    body.expectedPaths !== undefined &&
    (!Array.isArray(body.expectedPaths) ||
      body.expectedPaths.some((value) => typeof value !== "string"))
  )
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        "expectedPaths must be an array of paths from the cleanup preview.",
      ),
    );
  sendOk(
    response,
    await rendererWorkspace().maintain({
      dryRun: body.dryRun !== false,
      prune: body.prune === true,
      ...(body.expectedPaths === undefined
        ? {}
        : { expectedPaths: body.expectedPaths as string[] }),
    }),
  );
};
