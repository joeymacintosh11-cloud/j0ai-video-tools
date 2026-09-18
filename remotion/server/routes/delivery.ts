import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  DeliverView,
  DeliveryRevealView,
  DeliverySettingsView,
  DeliveryTargetView,
} from "../../src/domain/api/views.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import type { RenderPresetId } from "../../src/domain/video/renderPresets.ts";
import { revealDeliveryDestination } from "../../services/delivery/revealDelivery.ts";
import {
  DELIVERY_SETTINGS_FILE,
  readDeliverySettings,
  resolveDeliveryRoot,
  writeDeliverySettings,
} from "../../services/delivery/deliverySettings.ts";
import { readJsonBody, sendOk } from "../http/json.ts";
import { deliverPlanned, planDeliveries } from "../services/deliveryPlan.ts";

/**
 * Local delivery: settings, and copying finished exports to them.
 *
 * No endpoint here accepts a destination path for an operation. The root is
 * configured once, validated, and stored; every delivery request names tracks
 * and formats and the server resolves where those go. That is what keeps a
 * request from being able to write a video anywhere it likes.
 */

const toSettingsView = async (): Promise<DeliverySettingsView> => {
  const settings = await readDeliverySettings();
  const { root, problem } = resolveDeliveryRoot(settings);

  return {
    root: settings.root,
    available: root !== null,
    problem,
    autoDeliver: settings.autoDeliver,
    settingsPath: DELIVERY_SETTINGS_FILE,
  };
};

export const handleGetDeliverySettings = async (
  response: ServerResponse,
): Promise<void> => {
  sendOk(response, await toSettingsView());
};

export const handleUpdateDeliverySettings = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);

  if (body.root !== undefined && body.root !== null && typeof body.root !== "string") {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        '"root" must be an absolute folder path, or null to turn delivery off.',
      ),
    );
  }

  if (body.autoDeliver !== undefined && typeof body.autoDeliver !== "boolean") {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", '"autoDeliver" must be true or false.'),
    );
  }

  await writeDeliverySettings({
    ...(body.root === undefined ? {} : { root: body.root as string | null }),
    ...(body.autoDeliver === undefined
      ? {}
      : { autoDeliver: body.autoDeliver as boolean }),
  });

  sendOk(response, await toSettingsView());
};

/** Named tracks, or the catalogue asked for outright. Same rule as export-missing. */
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

const readPresets = (
  body: Record<string, unknown>,
): readonly RenderPresetId[] | null => {
  const { presets } = body;

  if (presets === undefined || presets === null) return null;

  if (!Array.isArray(presets) || presets.length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        '"presets" must be a non-empty array when provided, or left out to use each track\'s own formats.',
      ),
    );
  }

  return presets as readonly RenderPresetId[];
};

const toTargetViews = (
  targets: readonly DeliveryTargetView[],
): readonly DeliveryTargetView[] => targets;

/**
 * Copies every current export that is not already at the destination.
 *
 * With `dryRun` the same plan comes back with nothing copied, which is what
 * lets the UI show "4 to deliver, 11 already there" before starting. Exports
 * that are missing or stale are reported in `notCurrent` rather than delivered:
 * the destination must not receive content the tool already knows is out of
 * date.
 */
export const handleDeliver = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  const dryRun = body.dryRun === true;
  const settings = await readDeliverySettings();

  const plan = await planDeliveries({
    slugs: readSlugs(body),
    presetIds: readPresets(body),
    settings,
  });

  const common = {
    catalogue: plan.catalogue,
    tracks: plan.tracks,
    root: plan.root,
    rootProblem: plan.rootProblem,
    considered: toTargetViews(plan.considered),
    deliverable: toTargetViews(plan.deliverable),
    alreadyDelivered: toTargetViews(plan.alreadyDelivered),
    notCurrent: toTargetViews(plan.notCurrent),
    invalid: plan.invalid,
    nothingToDo: plan.deliverable.length === 0,
  };

  if (dryRun || plan.deliverable.length === 0) {
    const payload: DeliverView = { ...common, dryRun, delivered: [] };
    sendOk(response, payload);
    return;
  }

  const payload: DeliverView = {
    ...common,
    dryRun: false,
    delivered: await deliverPlanned(plan, settings),
  };

  sendOk(response, payload);
};

export const handleRevealDelivery = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  const payload: DeliveryRevealView = await revealDeliveryDestination(
    typeof body.slug === "string" ? body.slug : undefined,
    body.preset,
  );

  sendOk(response, payload);
};
