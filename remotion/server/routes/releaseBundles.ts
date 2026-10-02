import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ReleaseBundlesView,
  ReleaseBundleTrackView,
} from "../../core/domain/api/views.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { readDeliverySettings } from "../../services/delivery/deliverySettings.ts";
import type { ReleaseBundleState } from "../../services/delivery/releaseBundle.ts";
import { readJsonBody, sendOk } from "../http/json.ts";
import {
  generatePlannedBundles,
  planReleaseBundles,
} from "../../services/workflows/releaseBundlePlan.ts";

/**
 * Generates release bundles for named tracks or the whole catalogue.
 *
 * One endpoint for both, so a single track and a catalogue run behave
 * identically: each track is contained, and one folder that cannot be written
 * never stops the rest. No path is accepted — bundles go into each track's own
 * destination folder, which the server resolves from stored settings.
 */

const toTrackView = (state: ReleaseBundleState): ReleaseBundleTrackView => ({
  slug: state.slug,
  freshness: state.freshness,
  relativePath: state.relativePath,
  generatedAt: state.generatedAt,
  delivered: state.delivered,
  outdated: state.outdated,
  missing: state.missing,
  problem: state.problem,
});

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
      trackIssue(
        "INVALID_REQUEST",
        'Provide either "tracks" or "catalogue", not both.',
      ),
    );
  }

  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", 'Provide a non-empty "tracks" array.'),
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

export const handleReleaseBundles = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  const dryRun = body.dryRun === true;
  const force = body.force === true;
  const settings = await readDeliverySettings();

  const plan = await planReleaseBundles({
    slugs: readSlugs(body),
    settings,
  });

  const pending = force
    ? plan.missing.length + plan.outdated.length + plan.current.length
    : plan.missing.length + plan.outdated.length;

  const common = {
    catalogue: plan.catalogue,
    tracks: plan.tracks,
    root: plan.root,
    rootProblem: plan.rootProblem,
    current: plan.current.map(toTrackView),
    outdated: plan.outdated.map(toTrackView),
    missing: plan.missing.map(toTrackView),
    unavailable: plan.unavailable.map(toTrackView),
    nothingToDo: pending === 0,
  };

  if (dryRun || pending === 0) {
    const payload: ReleaseBundlesView = { ...common, dryRun, generated: [] };
    sendOk(response, payload);
    return;
  }

  const results = await generatePlannedBundles(plan, { settings, force });
  const payload: ReleaseBundlesView = {
    ...common,
    dryRun: false,
    generated: results.map((result) => ({
      slug: result.slug,
      freshness: result.freshness,
      relativePath: result.relativePath,
      generatedAt: null,
      delivered: result.delivered,
      outdated: result.outdated,
      missing: result.missing,
      problem: result.problem,
      generated: result.generated,
    })),
  };

  sendOk(response, payload);
};
