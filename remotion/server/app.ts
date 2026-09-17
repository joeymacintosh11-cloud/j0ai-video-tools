import type { IncomingMessage, ServerResponse } from "node:http";
import type { HealthView } from "../src/domain/api/views.ts";
import { sendErrorForException, sendNotFound } from "./http/errors.ts";
import { sendOk } from "./http/json.ts";
import {
  handleCancelRender,
  handleGetRender,
  handleGetRenderLogs,
  handleListRenders,
  handleRenderEvents,
} from "./routes/renders.ts";
import {
  handleCreateTrack,
  handleGetTrack,
  handleListTracks,
  handlePrepareTrack,
  handleStartRender,
  handleTrackPreview,
  handleUpdateMetadata,
  handleUploadAsset,
  handleValidateTrack,
} from "./routes/tracks.ts";

/**
 * Routes are matched on decoded path segments — no regex over raw URLs, and no
 * path ever reaches the filesystem without going through assertValidSlug() in
 * the service layer first.
 */
const segmentsOf = (pathname: string): string[] =>
  pathname
    .split("/")
    .filter((segment) => segment.length > 0)
    .map((segment) => decodeURIComponent(segment));

const route = async (
  request: IncomingMessage,
  response: ServerResponse,
  segments: string[],
): Promise<void> => {
  const method = request.method ?? "GET";
  const [api, collection, second, third] = segments;

  if (api !== "api") {
    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "health" && segments.length === 2) {
    if (method !== "GET") {
      sendNotFound(response, "Endpoint");
      return;
    }
    const health: HealthView = { ok: true, service: "toshi-visualizer" };
    sendOk(response, health);
    return;
  }

  if (collection === "tracks") {
    // /api/tracks
    if (second === undefined) {
      if (method === "GET") {
        await handleListTracks(request, response);
        return;
      }
      if (method === "POST") {
        await handleCreateTrack(request, response);
        return;
      }
      sendNotFound(response, "Endpoint");
      return;
    }

    // /api/tracks/:slug
    if (third === undefined) {
      if (method === "GET") {
        await handleGetTrack(second, response);
        return;
      }
      sendNotFound(response, "Endpoint");
      return;
    }

    // /api/tracks/:slug/<action>
    if (third === "metadata" && method === "PATCH") {
      await handleUpdateMetadata(second, request, response);
      return;
    }
    if (third === "validate" && method === "POST") {
      await handleValidateTrack(second, response);
      return;
    }
    if (third === "prepare" && method === "POST") {
      await handlePrepareTrack(second, response);
      return;
    }
    // The asset kind is fixed by the route, so an upload can only ever write
    // this track's cover.png or beat.wav.
    if (third === "cover" && method === "PUT") {
      await handleUploadAsset(second, "cover", request, response);
      return;
    }
    if (third === "beat" && method === "PUT") {
      await handleUploadAsset(second, "beat", request, response);
      return;
    }
    if (third === "preview" && method === "GET") {
      await handleTrackPreview(second, response);
      return;
    }
    if (third === "render" && method === "POST") {
      await handleStartRender(second, response);
      return;
    }

    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "renders") {
    // /api/renders
    if (second === undefined) {
      if (method === "GET") {
        handleListRenders(response);
        return;
      }
      sendNotFound(response, "Endpoint");
      return;
    }

    // /api/renders/:jobId
    if (third === undefined) {
      if (method === "GET") {
        handleGetRender(second, response);
        return;
      }
      sendNotFound(response, "Endpoint");
      return;
    }

    if (third === "events" && method === "GET") {
      handleRenderEvents(second, response);
      return;
    }
    if (third === "logs" && method === "GET") {
      handleGetRenderLogs(second, response);
      return;
    }
    if (third === "cancel" && method === "POST") {
      handleCancelRender(second, response);
      return;
    }

    sendNotFound(response, "Endpoint");
    return;
  }

  sendNotFound(response, "Endpoint");
};

export const handleRequest = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const pathname = new URL(request.url ?? "/", "http://localhost").pathname;

  try {
    await route(request, response, segmentsOf(pathname));
  } catch (error) {
    if (response.headersSent) {
      console.error(`[api] error after response started for ${pathname}:`, error);
      response.end();
      return;
    }

    sendErrorForException(
      response,
      error,
      `handling ${request.method ?? "GET"} ${pathname}`,
    );
  }
};
