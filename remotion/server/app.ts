import type { IncomingMessage, ServerResponse } from "node:http";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import type { HealthView } from "../core/domain/api/views.ts";
import { sendErrorForException, sendNotFound } from "./http/errors.ts";
import { sendOk } from "./http/json.ts";
import {
  handleDeliver,
  handleGetDeliverySettings,
  handleRevealDelivery,
  handleUpdateDeliverySettings,
} from "./routes/delivery.ts";
import {
  handleApplyDestinationFix,
  handleGetDestinationHealth,
  handlePlanDestinationFix,
} from "./routes/destinationHealth.ts";
import {
  handleGetDeliveryHistory,
  handleReconcileDeliveryHistory,
} from "./routes/deliveryHistory.ts";
import { handleExportMissing } from "./routes/exportMissing.ts";
import { handleListRenderers } from "./routes/renderers.ts";
import {
  handleCancelPublishJob,
  handleCreatePublishJob,
  handleExecutePublishJob,
  handleGetDestination,
  handleGetPublicationHistory,
  handleGetPublishJob,
  handleListDestinations,
  handleListPublishJobs,
  handlePlanPublication,
  handleRecoverPublishJob,
} from "./routes/publishing.ts";
import { handleInspectWorkspace, handleMaintainWorkspace } from "./routes/rendererWorkspace.ts";
import { handleGetRenderHistory } from "./routes/renderHistory.ts";
import {
  handleAdoptExistingExports,
  handleGetContentLibrary,
  handleGetContentLibraryRecord,
  handleReexportContentLibraryRecord,
} from "./routes/contentLibrary.ts";
import { handleGetContentPackage } from "./routes/contentPackage.ts";
import {
  handleApplyContentPackageBatch,
  handleInspectContentPackageBatch,
  handlePlanContentPackageBatch,
} from "./routes/contentPackageBatch.ts";
import {
  handleGetContentMetadataSettings,
  handleUpdateContentMetadataSettings,
} from "./routes/contentMetadataSettings.ts";
import { handleReleaseBundles } from "./routes/releaseBundles.ts";
import {
  handleBatchEvents,
  handleCancelBatch,
  handleCreateBatch,
  handleGetBatch,
  handleListBatches,
} from "./routes/batches.ts";
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
  handleRevealOutput,
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

  if (collection === "renderers" && segments.length === 2) {
    if (method !== "GET") {
      sendNotFound(response, "Endpoint");
      return;
    }
    handleListRenderers(response);
    return;
  }

  if (collection === "publish") {
    const fourth = segments[4];
    // /api/publish/destinations[/:id]
    if (second === "destinations" && method === "GET") {
      if (segments.length === 3) { handleListDestinations(response); return; }
      if (segments.length === 4) { handleGetDestination(third!, response); return; }
    }
    if (second === "plan" && segments.length === 3 && method === "POST") { await handlePlanPublication(request, response); return; }
    if (second === "receipts" && segments.length === 3 && method === "GET") { handleGetPublicationHistory(request, response); return; }
    if (second === "jobs") {
      // /api/publish/jobs
      if (segments.length === 3 && method === "GET") { await handleListPublishJobs(request, response); return; }
      if (segments.length === 3 && method === "POST") { await handleCreatePublishJob(request, response); return; }
      // /api/publish/jobs/:jobId[/execute|cancel|recover]
      if (segments.length === 4 && method === "GET") { await handleGetPublishJob(third!, response); return; }
      if (segments.length === 5 && method === "POST") {
        if (fourth === "execute") { await handleExecutePublishJob(third!, response); return; }
        if (fourth === "cancel") { await handleCancelPublishJob(third!, response); return; }
        if (fourth === "recover") { await handleRecoverPublishJob(third!, response); return; }
      }
    }
    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "ae-workspace") {
    if (segments.length === 2 && method === "GET") { await handleInspectWorkspace(response); return; }
    if (segments.length === 3 && second === "cleanup" && method === "POST") { await handleMaintainWorkspace(request, response); return; }
    sendNotFound(response, "Endpoint"); return;
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
      await handleStartRender(second, request, response);
      return;
    }
    if (third === "reveal" && method === "POST") {
      await handleRevealOutput(second, request, response);
      return;
    }

    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "delivery") {
    if (second === "settings" && third === undefined) {
      if (method === "GET") {
        await handleGetDeliverySettings(response);
        return;
      }
      if (method === "PUT") {
        await handleUpdateDeliverySettings(request, response);
        return;
      }
      sendNotFound(response, "Endpoint");
      return;
    }
    if (second === "deliver" && third === undefined && method === "POST") {
      await handleDeliver(request, response);
      return;
    }
    if (second === "reveal" && third === undefined && method === "POST") {
      await handleRevealDelivery(request, response);
      return;
    }

    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "delivery-history") {
    if (second === undefined && method === "GET") {
      await handleGetDeliveryHistory(request, response);
      return;
    }
    if (second === "reconcile" && third === undefined && method === "POST") {
      await handleReconcileDeliveryHistory(response);
      return;
    }

    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "destination-health") {
    // /api/destination-health
    if (second === undefined) {
      if (method === "GET") {
        await handleGetDestinationHealth(request, response);
        return;
      }
      sendNotFound(response, "Endpoint");
      return;
    }
    // /api/destination-health/plan, /api/destination-health/apply-plan
    if (third === undefined) {
      if (second === "plan" && method === "POST") {
        await handlePlanDestinationFix(request, response);
        return;
      }
      if (second === "apply-plan" && method === "POST") {
        await handleApplyDestinationFix(request, response);
        return;
      }
    }
    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "release-bundles" && segments.length === 2) {
    if (method === "POST") {
      await handleReleaseBundles(request, response);
      return;
    }
    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "export-missing" && segments.length === 2) {
    if (method === "POST") {
      await handleExportMissing(request, response);
      return;
    }
    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "content-package") {
    // /api/content-package
    if (segments.length === 2) {
      if (method === "GET") {
        await handleGetContentPackage(request, response);
        return;
      }
      sendNotFound(response, "Endpoint");
      return;
    }

    // /api/content-package/batch/inspect|plan|apply
    if (second === "batch" && third !== undefined && segments.length === 4) {
      if (method === "POST" && third === "inspect") {
        await handleInspectContentPackageBatch(request, response);
        return;
      }
      if (method === "POST" && third === "plan") {
        await handlePlanContentPackageBatch(request, response);
        return;
      }
      if (method === "POST" && third === "apply") {
        await handleApplyContentPackageBatch(request, response);
        return;
      }
    }

    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "content-metadata-settings" && segments.length === 2) {
    if (method === "GET") {
      await handleGetContentMetadataSettings(response);
      return;
    }
    if (method === "PATCH") {
      await handleUpdateContentMetadataSettings(request, response);
      return;
    }
    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "render-batches") {
    // /api/render-batches
    if (second === undefined) {
      if (method === "POST") {
        await handleCreateBatch(request, response);
        return;
      }
      if (method === "GET") {
        handleListBatches(response);
        return;
      }
      sendNotFound(response, "Endpoint");
      return;
    }

    // /api/render-batches/:batchId
    if (third === undefined) {
      if (method === "GET") {
        handleGetBatch(second, response);
        return;
      }
      sendNotFound(response, "Endpoint");
      return;
    }

    if (third === "events" && method === "GET") {
      handleBatchEvents(second, response);
      return;
    }
    if (third === "cancel" && method === "POST") {
      handleCancelBatch(second, response);
      return;
    }

    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "content-library") {
    if (second === undefined && method === "GET") {
      await handleGetContentLibrary(request, response);
      return;
    }
    if (second === "adopt" && third === undefined && method === "POST") {
      await handleAdoptExistingExports(response);
      return;
    }
    if (second !== undefined && third === undefined && method === "GET") {
      await handleGetContentLibraryRecord(response, second);
      return;
    }
    if (second !== undefined && third === "reexport" && segments.length === 4 && method === "POST") {
      await handleReexportContentLibraryRecord(response, second);
      return;
    }

    sendNotFound(response, "Endpoint");
    return;
  }

  if (collection === "render-history" && segments.length === 2) {
    if (method === "GET") {
      handleGetRenderHistory(request, response);
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
  let pathname = request.url ?? "/";

  try {
    let segments: string[];
    try {
      pathname = new URL(pathname, "http://localhost").pathname;
      segments = segmentsOf(pathname);
    } catch {
      throw new TrackError(trackIssue(
        "INVALID_REQUEST", "Request URL is malformed.",
      ));
    }
    await route(request, response, segments);
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
