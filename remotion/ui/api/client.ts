import type { ExportMode } from "../../src/domain/video/exportFreshness.ts";
import type {
  ApiError,
  ApiErrorCode,
  ApiResponse,
  CreateRenderBatchBody,
  CreateRenderBatchView,
  ExportMissingBody,
  ExportMissingView,
  CreateTrackBody,
  HealthView,
  PrepareTrackView,
  RenderBatchView,
  RenderJobView,
  RenderLogsView,
  RenderTarget,
  RevealOutputView,
  StartRenderView,
  TrackAssetKind,
  TrackDetailView,
  TrackMetadataPatch,
  TrackPreviewView,
  TrackSummaryView,
  UploadAssetView,
  ValidateTrackView,
} from "../../src/domain/api/views.ts";
import type { RenderPresetId } from "../../src/domain/video/renderPresets.ts";
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
    headers:
      payload === undefined
        ? undefined
        : { "content-type": "application/json" },
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

export const createTrack = (
  title: string,
  exportPresets?: readonly RenderPresetId[],
): Promise<TrackDetailView> => {
  const body: CreateTrackBody = { title, exportPresets };

  return jsonRequest<TrackDetailView>("/api/tracks", "POST", body);
};

export const updateTrackMetadata = (
  slug: string,
  patch: TrackMetadataPatch,
  revision?: string | null,
): Promise<TrackDetailView> =>
  request<TrackDetailView>(`/api/tracks/${encodeURIComponent(slug)}/metadata`, {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      ...(revision ? { "if-match": `"${revision}"` } : {}),
    },
    body: JSON.stringify(patch),
  });

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

/**
 * Uploads a cover or beat as a raw PUT body.
 *
 * No multipart form and no filename: the endpoint decides which file is being
 * written, so there is nothing for the client to name. The File is passed
 * straight to fetch, which streams it rather than reading it into memory.
 */
export const uploadTrackAsset = (
  slug: string,
  kind: TrackAssetKind,
  file: File,
): Promise<UploadAssetView> =>
  request<UploadAssetView>(`/api/tracks/${encodeURIComponent(slug)}/${kind}`, {
    method: "PUT",
    headers: {
      "content-type": kind === "cover" ? "image/png" : "audio/wav",
    },
    body: file,
  });

export const getTrackPreview = (
  slug: string,
): Promise<TrackPreviewView<BeatVisualizerProps>> =>
  request<TrackPreviewView<BeatVisualizerProps>>(
    `/api/tracks/${encodeURIComponent(slug)}/preview`,
  );

/** Shows a rendered file in Finder. Only the slug and format are sent. */
export const revealTrackOutput = (
  slug: string,
  preset?: RenderPresetId,
): Promise<RevealOutputView> =>
  jsonRequest<RevealOutputView>(
    `/api/tracks/${encodeURIComponent(slug)}/reveal`,
    "POST",
    preset === undefined ? {} : { preset },
  );

/* ------------------------------------------------------------------ *
 * Renders
 * ------------------------------------------------------------------ */

export const startRender = (
  slug: string,
  preset?: RenderPresetId,
): Promise<StartRenderView> =>
  jsonRequest<StartRenderView>(
    `/api/tracks/${encodeURIComponent(slug)}/render`,
    "POST",
    preset === undefined ? {} : { preset },
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

/* ------------------------------------------------------------------ *
 * Render batches
 * ------------------------------------------------------------------ */

export const createRenderBatch = (
  targets: readonly RenderTarget[],
): Promise<CreateRenderBatchView> => {
  const body: CreateRenderBatchBody = { targets };

  return jsonRequest<CreateRenderBatchView>(
    "/api/render-batches",
    "POST",
    body,
  );
};

export const listRenderBatches = (): Promise<readonly RenderBatchView[]> =>
  request<readonly RenderBatchView[]>("/api/render-batches");

export const getRenderBatch = (batchId: string): Promise<RenderBatchView> =>
  request<RenderBatchView>(
    `/api/render-batches/${encodeURIComponent(batchId)}`,
  );

export const cancelRenderBatch = (batchId: string): Promise<RenderBatchView> =>
  jsonRequest<RenderBatchView>(
    `/api/render-batches/${encodeURIComponent(batchId)}/cancel`,
    "POST",
  );

/**
 * Queues only the exports the given tracks do not already have.
 *
 * `tracks` of null covers the whole catalogue, and `presets` of null uses each
 * track's own declared intent rather than one list for all of them. With
 * `dryRun` the same plan comes back without anything being queued, which is
 * what lets the UI show a summary before committing.
 */
export const exportMissing = (
  tracks: readonly string[] | null,
  presets: readonly RenderPresetId[] | null,
  dryRun: boolean,
  mode: ExportMode = "missing",
): Promise<ExportMissingView> => {
  const body: ExportMissingBody = {
    ...(tracks === null ? { catalogue: true } : { tracks }),
    ...(presets === null ? {} : { presets }),
    dryRun,
    mode,
  };

  return jsonRequest<ExportMissingView>("/api/export-missing", "POST", body);
};

/** SSE endpoint for a batch's aggregate; consumed with EventSource. */
export const renderBatchEventsUrl = (batchId: string): string =>
  `/api/render-batches/${encodeURIComponent(batchId)}/events`;
