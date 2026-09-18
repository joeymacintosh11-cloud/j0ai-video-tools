import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CreateRenderBatchView,
  RenderTarget,
} from "../../src/domain/api/views.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { readJsonBody, sendOk } from "../http/json.ts";
import { openSseStream } from "../http/sse.ts";
import { renderManager } from "../services/renderManager.ts";

/** The most targets one request may queue, so a typo cannot flood the queue. */
const MAX_TARGETS = 50;

const readTargets = (body: Record<string, unknown>): RenderTarget[] => {
  const { targets } = body;

  if (!Array.isArray(targets) || targets.length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        'Provide a non-empty "targets" array, e.g. {"targets":[{"slug":"ghetto-geek","preset":"vertical-9x16"}]}.',
      ),
    );
  }

  if (targets.length > MAX_TARGETS) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        `A batch may contain at most ${MAX_TARGETS} targets; received ${targets.length}.`,
      ),
    );
  }

  return targets.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new TrackError(
        trackIssue(
          "INVALID_REQUEST",
          `targets[${index}] must be an object with "slug" and "preset".`,
        ),
      );
    }

    const { slug, preset } = entry as Record<string, unknown>;

    if (typeof slug !== "string" || slug.length === 0) {
      throw new TrackError(
        trackIssue("INVALID_REQUEST", `targets[${index}].slug must be a string.`),
      );
    }

    // The slug and preset are validated properly by the render manager, which
    // is the one place that decides what is renderable.
    return { slug, preset } as RenderTarget;
  });
};

export const handleCreateBatch = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const targets = readTargets(await readJsonBody(request));
  const { batch, skipped, locked } = renderManager.startBatch(targets);

  const payload: CreateRenderBatchView = {
    batchId: batch.id,
    batch,
    skipped,
    locked,
  };

  sendOk(response, payload);
};

export const handleListBatches = (response: ServerResponse): void => {
  sendOk(response, renderManager.listBatches());
};

export const handleGetBatch = (
  batchId: string,
  response: ServerResponse,
): void => {
  sendOk(response, renderManager.getBatch(batchId));
};

export const handleCancelBatch = (
  batchId: string,
  response: ServerResponse,
): void => {
  sendOk(response, renderManager.cancelBatch(batchId));
};

/**
 * Streams a batch's aggregate as its jobs progress.
 *
 * The current state is sent immediately on connect, so a client that attaches
 * late — or reloads mid-batch — starts from the truth rather than from zero.
 * The stream closes itself once every job has settled.
 */
export const handleBatchEvents = (
  batchId: string,
  response: ServerResponse,
): void => {
  // Throws RENDER_BATCH_NOT_FOUND before any SSE headers are written.
  const initial = renderManager.getBatch(batchId);

  const stream = openSseStream(response);
  stream.send("batch", initial);

  if (initial.status === "finished") {
    stream.send("finished", initial);
    stream.close();
    return;
  }

  const unsubscribe = renderManager.subscribeBatch(batchId, (event) => {
    stream.send("batch", event.batch);

    if (event.batch.status === "finished") {
      stream.send("finished", event.batch);
      stream.close();
    }
  });

  stream.onClose(unsubscribe);
};
