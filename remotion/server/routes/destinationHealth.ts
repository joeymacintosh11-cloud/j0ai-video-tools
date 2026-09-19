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
import {
  applyDestinationFixPlan,
  planDestinationFix,
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

  const result = await scanDestinationHealth({
    slugs,
    settings: await readDeliverySettings(),
  });

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
 */
export const handleApplyDestinationFix = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  const settings = await readDeliverySettings();

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

  const { plan, results } = await applyDestinationFixPlan({
    slugs: readSlugs(body),
    settings,
    actionIds: ids,
  });

  const payload: DestinationFixApplyView = { plan: toPlanView(plan), results };
  sendOk(response, payload);
};
