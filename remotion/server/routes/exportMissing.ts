import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ExportMissingView,
  PlannedTargetView,
} from "../../src/domain/api/views.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import type { RenderPresetId } from "../../src/domain/video/renderPresets.ts";
import { readJsonBody, sendOk } from "../http/json.ts";
import {
  allPresetIds,
  planMissingExports,
  toRenderTargets,
} from "../services/exportPlan.ts";
import { renderManager } from "../services/renderManager.ts";

const readSlugs = (body: Record<string, unknown>): readonly string[] => {
  const { tracks } = body;

  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        'Provide a non-empty "tracks" array, e.g. {"tracks":["ghetto-geek"]}.',
      ),
    );
  }

  return tracks.map((slug, index) => {
    if (typeof slug !== "string" || slug.length === 0) {
      throw new TrackError(
        trackIssue("INVALID_REQUEST", `tracks[${index}] must be a string.`),
      );
    }
    return slug;
  });
};

const readPresets = (body: Record<string, unknown>): readonly RenderPresetId[] => {
  const { presets } = body;

  // Omitted means "every format" — the common case for "export what's missing".
  if (presets === undefined || presets === null) {
    return allPresetIds();
  }

  if (!Array.isArray(presets) || presets.length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        '"presets" must be a non-empty array when provided.',
      ),
    );
  }

  // planMissingExports validates each id properly; this only checks the shape.
  return presets as readonly RenderPresetId[];
};

/**
 * Queues only the exports a set of tracks does not already have.
 *
 * With `dryRun` the same plan comes back without anything being queued, which
 * is what lets a UI show "3 missing, 2 already rendered" before committing.
 *
 * When nothing is missing this is a successful no-op: no batch is created, and
 * `nothingToDo` says so. Creating an empty batch would just be noise in the
 * queue and in the batch list.
 */
export const handleExportMissing = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  const dryRun = body.dryRun === true;

  const plan = await planMissingExports({
    slugs: readSlugs(body),
    presetIds: readPresets(body),
  });

  const toView = (targets: readonly PlannedTargetView[]) => targets;

  if (dryRun || plan.missing.length === 0) {
    const payload: ExportMissingView = {
      batchId: null,
      dryRun,
      // Reported even on a dry run — that is the point of previewing.
      missing: toView(plan.missing),
      queued: [],
      skippedExisting: toView(plan.skippedExisting),
      skippedQueued: toView(plan.skippedQueued),
      skippedActive: toView(plan.skippedActive),
      invalid: plan.invalid,
      nothingToDo: plan.missing.length === 0,
    };

    sendOk(response, payload);
    return;
  }

  const { batch } = renderManager.startBatch(toRenderTargets(plan));

  const payload: ExportMissingView = {
    batchId: batch.id,
    dryRun: false,
    missing: toView(plan.missing),
    queued: toView(plan.missing),
    skippedExisting: toView(plan.skippedExisting),
    skippedQueued: toView(plan.skippedQueued),
    skippedActive: toView(plan.skippedActive),
    invalid: plan.invalid,
    nothingToDo: false,
  };

  sendOk(response, payload);
};
