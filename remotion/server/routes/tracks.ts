import type { IncomingMessage, ServerResponse } from "node:http";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import {
  COMPOSITION_CONFIG,
  secondsToFrames,
} from "../../src/domain/video/compositionConfig.ts";
import { probeAudioDurationInSeconds } from "../../services/tracks/audioDuration.ts";
import { buildTrackProps } from "../../services/tracks/buildTrackProps.ts";
import { createTrack } from "../../services/tracks/createTrack.ts";
import { inspectTrack } from "../../services/tracks/inspectTrack.ts";
import { listTracks } from "../../services/tracks/listTracks.ts";
import { prepareTrack } from "../../services/tracks/prepareTrack.ts";
import { trackLocations } from "../../services/tracks/trackLocations.ts";
import {
  updateTrackMetadata,
  type TrackMetadataPatch,
} from "../../services/tracks/updateTrackMetadata.ts";
import { readJsonBody, sendOk } from "../http/json.ts";
import { renderManager } from "../services/renderManager.ts";
import { toTrackDetailView, toTrackSummaryView } from "../views/trackView.ts";

export const handleListTracks = async (
  _request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const tracks = await listTracks();

  sendOk(response, tracks.map(toTrackSummaryView));
};

export const handleGetTrack = async (
  slugInput: string,
  response: ServerResponse,
): Promise<void> => {
  const slug = assertValidSlug(slugInput);
  const inspection = await inspectTrack(slug);

  if (!inspection.facts.trackDirExists) {
    throw new TrackError(
      trackIssue(
        "TRACK_NOT_FOUND",
        `Track "${slug}" not found.`,
        `public/tracks/${slug}/`,
      ),
    );
  }

  sendOk(response, toTrackDetailView(inspection));
};

export const handleCreateTrack = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);
  const title = body.title;

  if (typeof title !== "string" || title.trim().length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        'Provide a track title, e.g. {"title":"Midnight Rider"}.',
      ),
    );
  }

  const { slug } = await createTrack(title);
  const inspection = await inspectTrack(slug);

  sendOk(response, toTrackDetailView(inspection));
};

const readMetadataPatch = (body: Record<string, unknown>): TrackMetadataPatch => {
  const patch: Record<string, unknown> = {};

  for (const field of ["title", "artist", "key", "subtitle"] as const) {
    const value = body[field];
    if (value !== undefined) {
      if (typeof value !== "string") {
        throw new TrackError(
          trackIssue("INVALID_REQUEST", `Field "${field}" must be a string.`),
        );
      }
      patch[field] = value;
    }
  }

  if (body.bpm !== undefined) {
    if (body.bpm !== null && typeof body.bpm !== "number") {
      throw new TrackError(
        trackIssue("INVALID_REQUEST", 'Field "bpm" must be a number or null.'),
      );
    }
    patch.bpm = body.bpm;
  }

  if (Object.keys(patch).length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        "Provide at least one of: title, artist, key, bpm, subtitle.",
      ),
    );
  }

  return patch as TrackMetadataPatch;
};

export const handleUpdateMetadata = async (
  slugInput: string,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const slug = assertValidSlug(slugInput);
  const patch = readMetadataPatch(await readJsonBody(request));

  await updateTrackMetadata(slug, patch);
  const inspection = await inspectTrack(slug);

  sendOk(response, toTrackDetailView(inspection));
};

export const handleValidateTrack = async (
  slugInput: string,
  response: ServerResponse,
): Promise<void> => {
  const slug = assertValidSlug(slugInput);
  const inspection = await inspectTrack(slug);

  sendOk(response, {
    slug,
    status: inspection.status,
    validation: inspection.validation,
    assets: toTrackSummaryView(inspection),
  });
};

export const handlePrepareTrack = async (
  slugInput: string,
  response: ServerResponse,
): Promise<void> => {
  const slug = assertValidSlug(slugInput);
  const startedAt = Date.now();

  const { analysis, metadata } = await prepareTrack(slug);
  const inspection = await inspectTrack(slug);

  sendOk(response, {
    slug,
    status: inspection.status,
    metadata,
    validation: inspection.validation,
    analysis: {
      path: inspection.paths.analysis,
      generated: analysis.regenerated,
      alreadyUpToDate: !analysis.regenerated,
    },
    elapsedMs: Date.now() - startedAt,
  });
};

export const handleTrackPreview = async (
  slugInput: string,
  response: ServerResponse,
): Promise<void> => {
  const slug = assertValidSlug(slugInput);
  const inspection = await inspectTrack(slug);

  if (inspection.metadata === null) {
    const firstError = inspection.validation.errors[0];
    throw new TrackError(
      firstError ??
        trackIssue(
          "METADATA_INVALID",
          `Track "${slug}" cannot be previewed yet.`,
        ),
    );
  }

  const analysisAvailable =
    inspection.facts.analysisExists && inspection.facts.analysisUpToDate;

  const durationInSeconds = await probeAudioDurationInSeconds(
    trackLocations(slug).beat,
  );

  sendOk(response, {
    slug,
    composition: COMPOSITION_CONFIG,
    durationInFrames: secondsToFrames(durationInSeconds),
    durationInSeconds,
    /** Ready to hand straight to <Player inputProps={...} />. */
    inputProps: buildTrackProps({
      slug,
      metadata: inspection.metadata,
      analysisAvailable,
    }),
    analysisAvailable,
    studioUrlHint: `/${COMPOSITION_CONFIG.id}`,
  });
};

export const handleStartRender = async (
  slugInput: string,
  response: ServerResponse,
): Promise<void> => {
  const slug = assertValidSlug(slugInput);
  const inspection = await inspectTrack(slug);

  // Reject an invalid track up front so the caller gets a real 4xx instead of
  // a job that fails a second later.
  if (!inspection.validation.ok) {
    const firstError = inspection.validation.errors[0];
    throw new TrackError(
      firstError ??
        trackIssue("METADATA_INVALID", `Track "${slug}" is not renderable.`),
    );
  }

  const job = renderManager.startRender(slug);

  sendOk(response, { jobId: job.id, status: job.status, job });
};
