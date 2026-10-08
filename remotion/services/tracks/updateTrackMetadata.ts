import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { withFileMutation, writeAtomicFile } from "./atomicFile.ts";
import { metadataRevision } from "./metadataRevision.ts";
import {
  parseEngagementSelection,
  type EngagementSelection,
} from "../../core/domain/content/engagementOptimizer.ts";
import { parseMetadataTemplates } from "../../core/domain/content/metadataTemplates.ts";
import type { TrackMetadataPatch } from "../../core/domain/api/views.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import {
  coerceMetadataDraft,
  serializeTrackMetadata,
  validateTrackMetadata,
} from "../../core/domain/tracks/metadata.ts";
import {
  publicLabel,
  trackAssetPaths,
} from "../../core/domain/tracks/paths.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import type {
  TrackMetadata,
  TrackMetadataDraft,
} from "../../core/domain/tracks/types.ts";
import { trackLocations } from "./trackLocations.ts";

/** Declared in core/domain/api/views.ts, since it is also the PATCH body. */
export type { TrackMetadataPatch };

export type UpdateTrackMetadataResult = {
  readonly slug: string;
  readonly metadata: TrackMetadata;
};

const readExistingDraft = async (
  slug: string,
): Promise<{ current: TrackMetadataDraft; revision: string; storedEngagement: unknown }> => {
  const locations = trackLocations(slug);
  const source = publicLabel(trackAssetPaths(slug).metadata);

  if (!existsSync(locations.metadata)) {
    throw new TrackError(
      trackIssue(
        "METADATA_MISSING",
        `Track "${slug}" is missing metadata: ${source}`,
        source,
      ),
    );
  }

  const raw = await readFile(locations.metadata, "utf-8");

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new TrackError(
      trackIssue(
        "METADATA_INVALID",
        `${source} is not valid JSON: ${reason}`,
        source,
      ),
    );
  }

  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const override = (parsed as Record<string, unknown>).contentMetadataOverrides;
    const { problems } = parseMetadataTemplates(override);
    if (problems.length > 0) {
      throw new TrackError(trackIssue("TEMPLATE_INVALID", `${source}: ${problems.join(" ")}`, source));
    }
  }

  const current = coerceMetadataDraft(parsed);

  if (current === null) {
    throw new TrackError(
      trackIssue(
        "METADATA_INVALID",
        `${source} must contain a JSON object.`,
        source,
      ),
    );
  }

  // Verbatim, not coerced: a hook or field this version does not know (a
  // newer app's, or a hand edit) is still the user's, and an unrelated save
  // must write it back untouched rather than normalise it away.
  const storedEngagement = (parsed as Record<string, unknown>).engagement;

  return { current, revision: metadataRevision(raw), storedEngagement };
};

/**
 * undefined: the patch leaves engagement alone. null: clear it. Otherwise the
 * whole new selection, which must be valid — an invalid one is refused, never
 * coerced into a silent clear.
 */
const requestedEngagementFor = (
  value: unknown,
  source: string,
): EngagementSelection | null | undefined => {
  if (value === undefined) return undefined;
  const { selection, problems } = parseEngagementSelection(value);
  if (problems.length > 0) throw new TrackError(trackIssue("INVALID_REQUEST", `${source}: ${problems.join(" ")}`, source));
  return selection;
};

/**
 * Merges a patch into a track's metadata.json.
 *
 * Validates the merged result *before* writing, so an invalid patch can never
 * leave a corrupt file behind. The write itself goes to a temp file and is
 * renamed into place, which is atomic on the same filesystem — a reader either
 * sees the old file or the new one, never a half-written one.
 *
 * The slug (and therefore the folder name) is never changed by a title edit.
 */
export const updateTrackMetadata = async (
  slugInput: string,
  patch: TrackMetadataPatch,
  expectedRevision?: string,
): Promise<UpdateTrackMetadataResult> => {
  const slug = assertValidSlug(slugInput);
  const locations = trackLocations(slug);
  const source = publicLabel(trackAssetPaths(slug).metadata);

  return withFileMutation(locations.metadata, async () => {
    try {
      // An explicit engagement value is checked here, not only at the HTTP
      // boundary, so no caller can clear a saved choice with a malformed one.
      const requestedEngagement = requestedEngagementFor(patch.engagement, source);
      const { current, revision, storedEngagement } = await readExistingDraft(slug);
      const conflict = () => new TrackError(trackIssue(
        "METADATA_CONFLICT",
        "Metadata changed since it was read. Refresh the track before saving again.",
        source,
      ));
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw conflict();
      }

      const merged: TrackMetadataDraft = {
        title: patch.title ?? current.title,
        artist: patch.artist ?? current.artist,
        key: patch.key ?? current.key,
        bpm: patch.bpm === undefined ? current.bpm : patch.bpm,
        subtitle: patch.subtitle ?? current.subtitle,
        // Left alone unless the patch names it: editing a title must not
        // materialise an intent the track never declared.
        exportPresets: patch.exportPresets ?? current.exportPresets,
        // Omitted leaves it, `null` clears it back to the default renderer.
        renderer:
          patch.renderer === undefined
            ? current.renderer
            : (patch.renderer ?? undefined),
        // An empty string clears the override, which falls back to the slug.
        deliveryFolder:
          patch.deliveryFolder === undefined
            ? current.deliveryFolder
            : patch.deliveryFolder.trim() === ""
              ? undefined
              : patch.deliveryFolder.trim(),
        // The whole object is replaced, never deep-merged with what is
        // already on disk: `null` clears every override (inherit
        // everything), an object is the complete desired set, and omitting
        // the field entirely leaves it alone — exactly the exportPresets
        // convention.
        contentMetadataOverrides:
          patch.contentMetadataOverrides === undefined
            ? current.contentMetadataOverrides
            : (patch.contentMetadataOverrides ?? undefined),
        engagement: requestedEngagement === undefined ? current.engagement : (requestedEngagement ?? undefined),
      };
      const { issues, metadata } = validateTrackMetadata(merged, source);
      if (metadata === null) {
        throw new TrackError(issues[0] ??
          trackIssue("METADATA_INVALID", `${source} is not valid.`, source));
      }

      await writeAtomicFile(
        locations.metadata,
        (handle) =>
          handle.writeFile(
            serializeTrackMetadata({
              ...metadata,
              // Untouched by this patch: written back exactly as it was read,
              // even a value only a newer version understands.
              engagement:
                requestedEngagement === undefined
                  ? (storedEngagement as EngagementSelection | undefined)
                  : metadata.engagement,
            }),
            "utf-8",
          ),
        async () => {
          // Catch edits made outside this process while we staged the update.
          const latest = await readFile(locations.metadata, "utf-8");
          if (metadataRevision(latest) !== revision) throw conflict();
        },
      );
      return { slug, metadata };
    } catch (error) {
      if (error instanceof TrackError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new TrackError(trackIssue(
        "METADATA_WRITE_FAILED", `Could not write ${source}: ${reason}`, source,
      ));
    }
  });
};
