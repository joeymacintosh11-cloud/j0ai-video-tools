import { assertExportMode } from "../../src/domain/video/exportFreshness.ts";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ExportMissingView } from "../../src/domain/api/views.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import type { RenderPresetId } from "../../src/domain/video/renderPresets.ts";
import { readJsonBody, sendOk } from "../http/json.ts";
import { planMissingExports, toRenderTargets } from "../services/exportPlan.ts";
import { renderManager } from "../services/renderManager.ts";

/**
 * Which tracks to cover: the ones named, or every one of them.
 *
 * Returning undefined means the catalogue. That has to be asked for outright,
 * so a request that simply forgot its `tracks` array is an error rather than a
 * catalogue-wide queue.
 */
const readSlugs = (
  body: Record<string, unknown>,
): readonly string[] | undefined => {
  const { tracks, catalogue } = body;
  const wantsCatalogue = catalogue === true;

  if (tracks === undefined || tracks === null) {
    if (wantsCatalogue) {
      return undefined;
    }

    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        'Provide a non-empty "tracks" array, e.g. {"tracks":["ghetto-geek"]}, ' +
          'or {"catalogue":true} to cover every track.',
      ),
    );
  }

  if (wantsCatalogue) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        'Provide either "tracks" or "catalogue", not both.',
      ),
    );
  }

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

/**
 * Formats named by the caller, or null to use each track's declared intent.
 *
 * Omitting them is the ordinary case now: "export what's missing" means what
 * each track says it ships in, which may differ from track to track.
 */
const readPresets = (
  body: Record<string, unknown>,
): readonly RenderPresetId[] | null => {
  const { presets } = body;

  if (presets === undefined || presets === null) {
    return null;
  }

  if (!Array.isArray(presets) || presets.length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        '"presets" must be a non-empty array when provided, or left out to use each track\'s own formats.',
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
    mode: assertExportMode(body.mode),
    slugs: readSlugs(body),
    presetIds: readPresets(body),
    inFlight: renderManager.inFlightTargets(),
  });

  // Inspection is asynchronous; another request may have queued the same
  // target meanwhile. Recheck immediately before the synchronous batch enqueue.
  const live = renderManager.inFlightTargets();
  const newlyQueued = plan.selected.filter(
    (target) => live.get(`${target.slug}::${target.presetId}`) === "queued",
  );
  const newlyActive = plan.selected.filter(
    (target) => live.get(`${target.slug}::${target.presetId}`) === "active",
  );
  const selected = plan.selected.filter(
    (target) => !live.has(`${target.slug}::${target.presetId}`),
  );

  const common = {
    mode: plan.mode,
    stale: plan.stale,
    current: plan.current,
    selected,
    catalogue: plan.catalogue,
    tracks: plan.tracks,
    intendedTargets: plan.intendedTargets,
    // Reported even on a dry run — that is the point of previewing.
    missing: plan.missing,
    skippedExisting: plan.skippedExisting,
    skippedQueued: [...plan.skippedQueued, ...newlyQueued],
    skippedActive: [...plan.skippedActive, ...newlyActive],
    invalid: plan.invalid,
  };

  if (dryRun || selected.length === 0) {
    const payload: ExportMissingView = {
      ...common,
      batchId: null,
      dryRun,
      queued: [],
      nothingToDo: selected.length === 0,
    };

    sendOk(response, payload);
    return;
  }

  const { batch } = renderManager.startBatch(
    toRenderTargets({ ...plan, selected }),
  );
  const queuedKeys = new Set(
    batch.jobs.map((job) => `${job.slug}::${job.presetId}`),
  );

  const payload: ExportMissingView = {
    ...common,
    batchId: batch.id,
    dryRun: false,
    queued: selected.filter((target) =>
      queuedKeys.has(`${target.slug}::${target.presetId}`),
    ),
    nothingToDo: false,
  };

  sendOk(response, payload);
};
