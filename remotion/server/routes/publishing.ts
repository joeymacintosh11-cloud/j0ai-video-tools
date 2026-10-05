import type { IncomingMessage, ServerResponse } from "node:http";
import { publishDestinations } from "../../adapters/publishDestinations.mts";
import { isAccountId } from "../../core/domain/publishing/publicationReceipt.ts";
import { parsePublicationSourceRef } from "../../core/domain/publishing/publicationSource.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import { assertRenderPresetId } from "../../core/domain/video/renderPresets.ts";
import { isRendererId, type RendererId } from "../../core/domain/video/renderers.ts";
import { createPublishingService, type PublishInput } from "../../services/publishing/publishing.ts";
import { readJsonBody, sendOk } from "../http/json.ts";

/**
 * /api/publish/* — publishing an existing export to a destination.
 *
 * Thin: parsing and validation of identifiers here, everything else in
 * services/publishing. One service instance per server process, so a cancel
 * request reaches the execution it names. Responses never carry credentials
 * or absolute paths (destination status, jobs and receipts hold neither).
 */

export const publishing = createPublishingService(publishDestinations, {
  log: (message) => console.log(`[publish] ${message}`),
});

const invalid = (message: string): never => {
  throw new TrackError(trackIssue("INVALID_REQUEST", message));
};

const publishInput = (body: Record<string, unknown>): PublishInput => {
  if (typeof body.destination !== "string" || body.destination.length === 0)
    invalid('Provide "destination": a destination id from GET /api/publish/destinations.');
  if (body.accountId !== undefined && body.accountId !== null && !isAccountId(body.accountId))
    invalid("accountId must be a short identifier, or omitted.");
  return {
    destinationId: body.destination,
    source: parsePublicationSourceRef(body.source),
    metadata: body.metadata ?? {},
    accountId: (body.accountId as string | null | undefined) ?? null,
  };
};

const queryOf = (request: IncomingMessage) => new URL(request.url ?? "/", "http://localhost").searchParams;

export const handleListDestinations = (response: ServerResponse): void => {
  sendOk(response, publishing.destinations());
};

export const handleGetDestination = (id: string, response: ServerResponse): void => {
  sendOk(response, publishDestinations.describe(id));
};

export const handlePlanPublication = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  sendOk(response, await publishing.plan(publishInput(await readJsonBody(request))));
};

export const handleCreatePublishJob = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  sendOk(response, await publishing.createJob(publishInput(await readJsonBody(request))));
};

export const handleListPublishJobs = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
  const query = queryOf(request);
  const track = query.get("track");
  const destination = query.get("destination");
  sendOk(
    response,
    await publishing.listJobs({
      ...(track === null ? {} : { track: assertValidSlug(track) }),
      ...(destination === null ? {} : { destination }),
    }),
  );
};

export const handleGetPublishJob = async (jobId: string, response: ServerResponse): Promise<void> => {
  sendOk(response, await publishing.getJob(jobId));
};

export const handleExecutePublishJob = async (jobId: string, response: ServerResponse): Promise<void> => {
  sendOk(response, await publishing.execute(jobId));
};

export const handleCancelPublishJob = async (jobId: string, response: ServerResponse): Promise<void> => {
  sendOk(response, await publishing.cancel(jobId));
};

export const handleRecoverPublishJob = async (jobId: string, response: ServerResponse): Promise<void> => {
  sendOk(response, await publishing.recover(jobId));
};

export const handleGetPublicationHistory = (request: IncomingMessage, response: ServerResponse): void => {
  const query = queryOf(request);
  const track = query.get("track");
  const destination = query.get("destination");
  const format = query.get("format");
  const renderer = query.get("renderer");
  const limit = query.get("limit");
  if (renderer !== null && !isRendererId(renderer)) invalid(`Unknown renderer "${renderer}".`);
  if (limit !== null && !/^[1-9][0-9]{0,2}$/.test(limit)) invalid("limit must be a whole number from 1 to 500.");
  sendOk(
    response,
    publishing.history({
      ...(track === null ? {} : { track: assertValidSlug(track) }),
      ...(destination === null ? {} : { destination }),
      ...(format === null ? {} : { format: assertRenderPresetId(format) }),
      ...(renderer === null ? {} : { renderer: renderer as RendererId }),
      ...(limit === null ? {} : { limit: Number(limit) }),
    }),
  );
};
