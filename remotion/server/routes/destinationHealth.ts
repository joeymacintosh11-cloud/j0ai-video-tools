import type { IncomingMessage, ServerResponse } from "node:http";
import type { DestinationHealthView } from "../../src/domain/api/views.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { readDeliverySettings } from "../../services/delivery/deliverySettings.ts";
import { sendOk } from "../http/json.ts";
import { scanDestinationHealth } from "../services/destinationHealth.ts";

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
