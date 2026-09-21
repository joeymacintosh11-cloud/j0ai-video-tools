import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DestinationFixApplyView,
  DestinationFixPlanView,
  DestinationHealthView,
} from "../../src/domain/api/views.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { readDeliverySettings } from "../../services/delivery/deliverySettings.ts";
import { readJsonBody, sendOk } from "../http/json.ts";
import { scanDestinationHealth } from "../services/destinationHealth.ts";
import { enrichDestinationHealthWithRenderContext } from "../services/destinationHealthRenderContext.ts";
import {
  applyDestinationFixPlan,
  planDestinationFix,
  type ApplyDestinationFixInput,
  type DestinationFixPlan,
} from "../services/destinationFixPlan.ts";

/**
 * Scans the configured destination for drift against current records.
 *
 * Read-only, so this is a GET, exactly like delivery history: no path is
 * accepted, and the destination comes from stored settings. `track` may be
 * repeated to scan a named subset; omitted entirely, it scans the catalogue.
 */
export const handleGetDestinationHealth = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const { searchParams } = new URL(request.url ?? "/", "http://localhost");
  const named = searchParams.getAll("track");
  if (named.some((value) => value.trim().length === 0) || named.length > 100) {
    throw new TrackError(trackIssue("INVALID_REQUEST", "Provide 1 to 100 non-empty track slugs."));
  }
  const slugs =
    named.length === 0 ? undefined : named.map((slug) => assertValidSlug(slug));

  const scanned = await scanDestinationHealth({
    slugs,
    settings: await readDeliverySettings(),
  });
  // Explanatory-only: composed after the scan has already decided every
  // finding, never before. Not applied to the fix planner (see
  // server/services/destinationHealthRenderContext.ts's own comment) — only
  // this read-only endpoint enriches its response.
  const result = enrichDestinationHealthWithRenderContext(scanned);

  const payload: DestinationHealthView = {
    status: result.status,
    catalogue: result.catalogue,
    root: result.root,
    rootProblem: result.rootProblem,
    rootFindings: result.rootFindings,
    tracks: result.tracks,
    counts: result.counts,
    scannedAt: result.scannedAt,
    invalid: result.invalid,
  };

  sendOk(response, payload);
};

/** Named tracks, or the catalogue asked for outright. Same rule as delivery. */
const readSlugs = (
  body: Record<string, unknown>,
): readonly string[] | undefined => {
  const { tracks, catalogue } = body;
  const wantsCatalogue = catalogue === true;

  if (tracks === undefined || tracks === null) {
    if (wantsCatalogue) return undefined;
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
      trackIssue("INVALID_REQUEST", 'Provide either "tracks" or "catalogue", not both.'),
    );
  }

  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new TrackError(trackIssue("INVALID_REQUEST", 'Provide a non-empty "tracks" array.'));
  }

  return tracks.map((slug, index) => {
    if (typeof slug !== "string" || slug.length === 0) {
      throw new TrackError(trackIssue("INVALID_REQUEST", `tracks[${index}] must be a string.`));
    }
    return slug;
  });
};

const toPlanView = (plan: DestinationFixPlan): DestinationFixPlanView => ({
  status: plan.status,
  catalogue: plan.catalogue,
  root: plan.root,
  rootProblem: plan.rootProblem,
  scannedAt: plan.scannedAt,
  findings: plan.findings,
  actions: plan.actions,
  summary: plan.summary,
  invalid: plan.invalid,
});

/**
 * Proposes remediation actions for current destination drift.
 *
 * Always a dry run — nothing here writes or deletes anything. It exists only
 * so a caller can review a plan (and its action ids) before ever calling
 * apply-plan.
 */
export const handlePlanDestinationFix = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  const settings = await readDeliverySettings();
  const plan = await planDestinationFix({ slugs: readSlugs(body), settings });

  sendOk(response, toPlanView(plan));
};

/**
 * Runs the named safe action ids, after re-deriving the plan fresh.
 *
 * The client can never invent a filesystem path or an operation: every action
 * actually run is one `planDestinationFix` independently proposes right now,
 * from current state, not from anything the client sent beyond an id. See
 * `applyDestinationFixPlan` for the full revalidation and dependency rules.
 *
 * `waitForCompletion` (off by default) makes a rerender_and_deliver action
 * follow its render job through to a final, confirmed result —
 * completed/render_failed/delivery_failed/cancelled/timed_out — instead of
 * returning `queued` immediately. This call then does not return until that
 * happens or `timeoutMs` elapses (default 5 minutes, capped at 30), so a
 * caller that wants live progress meanwhile should use the `jobId` this
 * still returns for a `queued` result and the existing per-job SSE endpoint,
 * then call this again with `waitForCompletion` and the returned action/job
 * pair in `followJobs`. That second call follows the exact job; it never
 * starts a replacement if the first job failed or was cancelled.
 */
export const handleApplyDestinationFix = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);

  const { actionIds } = body;
  if (!Array.isArray(actionIds) || actionIds.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", 'Provide a non-empty "actionIds" array.'),
    );
  }
  const ids = actionIds.map((id, index) => {
    if (typeof id !== "string" || id.length === 0) {
      throw new TrackError(trackIssue("INVALID_REQUEST", `actionIds[${index}] must be a string.`));
    }
    return id;
  });

  const { waitForCompletion, timeoutMs, followJobs } = body;
  if (waitForCompletion !== undefined && typeof waitForCompletion !== "boolean") {
    throw new TrackError(trackIssue("INVALID_REQUEST", '"waitForCompletion" must be true or false.'));
  }
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") {
    throw new TrackError(trackIssue("INVALID_REQUEST", '"timeoutMs" must be a number.'));
  }
  if (followJobs !== undefined && (!Array.isArray(followJobs) ||
      followJobs.some((entry) => typeof entry !== "object" || entry === null ||
        typeof entry.actionId !== "string" || typeof entry.jobId !== "string"))) {
    throw new TrackError(trackIssue("INVALID_REQUEST", '"followJobs" must be an array of actionId/jobId pairs.'));
  }

  const { plan, results } = await applyDestinationFixPlan({
    slugs: readSlugs(body),
    actionIds: ids,
    waitForCompletion,
    timeoutMs,
    followJobs: followJobs as ApplyDestinationFixInput["followJobs"],
  });

  const payload: DestinationFixApplyView = { plan: toPlanView(plan), results };
  sendOk(response, payload);
};
