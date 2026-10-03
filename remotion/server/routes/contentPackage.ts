import type { IncomingMessage, ServerResponse } from "node:http";
import {
  deriveContentPackage,
  type ContentPackageInput,
} from "../../core/domain/content/contentPackage.ts";
import { assertPlatformId, type PlatformId } from "../../core/domain/content/platformProfiles.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import { readContentMetadataSettings } from "../../services/content/metadataTemplateSettings.ts";
import { inspectTrack } from "../../services/tracks/inspectTrack.ts";
import { sendOk } from "../http/json.ts";
import { renderManager } from "../../services/workflows/renderManager.ts";
import { deliveryRootForView } from "../../services/workflows/trackView.ts";
import { toTrackDetailView } from "../../services/workflows/trackView.ts";

/**
 * GET /api/content-package?track=<slug>&mode=intent|full&platform=<id>...
 *
 * A read-only, derived view — see core/domain/content/contentPackage.ts. It
 * reuses exactly the state `GET /api/tracks/:slug` already gathers (export
 * coverage/freshness, queue state, delivery state) rather than scanning
 * anything a second time, so this costs one track inspection, not a new
 * filesystem sweep.
 */
export const handleGetContentPackage = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const url = new URL(request.url ?? "/", "http://localhost");
  const slugParam = url.searchParams.get("track");

  if (slugParam === null || slugParam.length === 0) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        'Provide a "track" query parameter, e.g. /api/content-package?track=ghetto-geek.',
      ),
    );
  }

  const slug = assertValidSlug(slugParam);
  const modeParam = url.searchParams.get("mode");

  if (modeParam !== null && modeParam !== "intent" && modeParam !== "full") {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", 'mode must be "intent" or "full".'),
    );
  }

  const platformParams = url.searchParams.getAll("platform");
  const platforms: readonly PlatformId[] | undefined =
    platformParams.length > 0
      ? platformParams.map((value) => assertPlatformId(value))
      : undefined;

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

  const detail = toTrackDetailView(
    inspection,
    renderManager.inFlightExports(),
    await deliveryRootForView(),
  );

  const input: ContentPackageInput = {
    slug: detail.slug,
    title: detail.title,
    validationOk: detail.validation.ok,
    metadata: detail.metadata,
    exports: detail.exports,
    renderer: detail.exportsRenderer,
    contentMetadataOverrides: detail.metadata?.contentMetadataOverrides,
  };

  const { settings: templateSettings, problem: templatesProblem } =
    await readContentMetadataSettings();

  const view = deriveContentPackage(input, {
    mode: modeParam === "full" ? "full" : "intent",
    platforms,
    globalTemplates: templateSettings.templates,
    templatesProblem,
  });

  sendOk(response, view);
};
