import type {
  ApiError,
  ApiErrorCode,
  ApiResponse,
  CreateTrackBody,
  HealthView,
  PrepareTrackView,
  RenderJobView,
  RenderLogsView,
  StartRenderView,
  TrackDetailView,
  TrackMetadataPatch,
  TrackPreviewView,
  TrackSummaryView,
  ValidateTrackView,
} from "../../src/domain/api/views.ts";
import type { BeatVisualizerProps } from "../../src/BeatVisualizer/BeatVisualizer.ts";

/**
 * Typed client for the local API.
 *
 * Requests go to a relative /api path, which the Vite dev server proxies to the
 * API server on 127.0.0.1:4600. Because the browser only ever sees one origin,
 * there is nothing to configure here and the server needs no CORS handling.
 *
 * The UI never re-implements validation, slug rules or path building — it calls
 * these functions and renders whatever comes back.
 */

/** A structured failure from the API, carrying the shared domain error code. */
export class ApiRequestError extends Error {
  readonly code: ApiErrorCode;
  readonly path: string | undefined;
  readonly details: string | undefined;
  readonly status: number;

  constructor(status: number, error: ApiError) {
    super(error.message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = error.code;
    this.path = error.path;
    this.details = error.details;
  }
}

/**
 * The API server not running is the single most likely failure in local use, so
 * it gets a message that says what to do rather than a raw fetch error.
 */
const OFFLINE_MESSAGE =
  "Could not reach the local API server. Start it with `npm run server`.";

const request = async <TData>(
  path: string,
  init?: RequestInit,
): Promise<TData> => {
  let response: Response;

  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiRequestError(0, {
      code: "INTERNAL_ERROR",
      message: OFFLINE_MESSAGE,
    });
  }

  let body: ApiResponse<TData>;

  try {
    body = (await response.json()) as ApiResponse<TData>;
  } catch {
    // A non-JSON response means something other than the API answered — a
    // proxy error page, say. Report the status rather than a parse error.
    throw new ApiRequestError(response.status, {
      code: "INTERNAL_ERROR",
      message: `The API returned an unreadable ${response.status} response.`,
    });
  }

  if (!body.ok) {
    throw new ApiRequestError(response.status, body.error);
  }

  return body.data;
};

const jsonRequest = async <TData>(
  path: string,
  method: "POST" | "PATCH",
  payload?: unknown,
): Promise<TData> =>
  request<TData>(path, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });

/* ------------------------------------------------------------------ *
 * Tracks
 * ------------------------------------------------------------------ */

export const getHealth = (): Promise<HealthView> =>
  request<HealthView>("/api/health");

export const listTracks = (): Promise<readonly TrackSummaryView[]> =>
  request<readonly TrackSummaryView[]>("/api/tracks");

export const getTrack = (slug: string): Promise<TrackDetailView> =>
  request<TrackDetailView>(`/api/tracks/${encodeURIComponent(slug)}`);

export const createTrack = (title: string): Promise<TrackDetailView> => {
  const body: CreateTrackBody = { title };

  return jsonRequest<TrackDetailView>("/api/tracks", "POST", body);
};

export const updateTrackMetadata = (
  slug: string,
  patch: TrackMetadataPatch,
): Promise<TrackDetailView> =>
  jsonRequest<TrackDetailView>(
    `/api/tracks/${encodeURIComponent(slug)}/metadata`,
    "PATCH",
    patch,
  );

export const validateTrack = (slug: string): Promise<ValidateTrackView> =>
  jsonRequest<ValidateTrackView>(
    `/api/tracks/${encodeURIComponent(slug)}/validate`,
    "POST",
  );

export const prepareTrack = (slug: string): Promise<PrepareTrackView> =>
  jsonRequest<PrepareTrackView>(
    `/api/tracks/${encodeURIComponent(slug)}/prepare`,
    "POST",
  );

export const getTrackPreview = (
  slug: string,
): Promise<TrackPreviewView<BeatVisualizerProps>> =>
  request<TrackPreviewView<BeatVisualizerProps>>(
    `/api/tracks/${encodeURIComponent(slug)}/preview`,
  );

/* ------------------------------------------------------------------ *
 * Renders
 * ------------------------------------------------------------------ */

export const startRender = (slug: string): Promise<StartRenderView> =>
  jsonRequest<StartRenderView>(
    `/api/tracks/${encodeURIComponent(slug)}/render`,
    "POST",
  );

export const listRenders = (): Promise<readonly RenderJobView[]> =>
  request<readonly RenderJobView[]>("/api/renders");

export const getRender = (jobId: string): Promise<RenderJobView> =>
  request<RenderJobView>(`/api/renders/${encodeURIComponent(jobId)}`);

export const getRenderLogs = (jobId: string): Promise<RenderLogsView> =>
  request<RenderLogsView>(`/api/renders/${encodeURIComponent(jobId)}/logs`);

export const cancelRender = (jobId: string): Promise<RenderJobView> =>
  jsonRequest<RenderJobView>(
    `/api/renders/${encodeURIComponent(jobId)}/cancel`,
    "POST",
  );

/** SSE endpoint for a job's live progress; consumed with EventSource. */
export const renderEventsUrl = (jobId: string): string =>
  `/api/renders/${encodeURIComponent(jobId)}/events`;
