import type {
  ContentPackageView,
  DestinationStatus,
  PublishJobState,
  PublishPlanView,
  PublishRequestBody,
} from "../../core/domain/api/views.ts";
import { platformsForPreset } from "../../core/domain/content/platformProfiles.ts";
import {
  normalizeTag,
  seedPublicationMetadata,
} from "../../core/domain/publishing/publicationMetadata.ts";
import type { PublicationVisibility } from "../../core/domain/publishing/destinations.ts";
import { PUBLISH_PROBLEM_LABELS } from "../../core/domain/publishing/publishProblems.ts";
import type { RendererId } from "../../core/domain/video/renderers.ts";
import type { RenderPresetId } from "../../core/domain/video/renderPresets.ts";

/**
 * Pure state for the Publish panel, so its choices are testable without a
 * browser. Nothing here decides whether a publication may go ahead — that is
 * always the server's plan. This only builds requests and labels answers.
 */

export type PublishDraft = {
  readonly destination: string;
  readonly format: RenderPresetId;
  /** Whose export: always explicit in the request, never inferred by the server. */
  readonly renderer: RendererId;
  readonly title: string;
  readonly description: string;
  /** Comma/space separated, as typed. */
  readonly tags: string;
  readonly visibility: PublicationVisibility;
};

/** The first ready destination, else the first implemented one, else the first listed. */
export const defaultDestination = (destinations: readonly DestinationStatus[]): string =>
  (destinations.find((d) => d.state === "ready") ?? destinations.find((d) => d.implemented) ?? destinations[0])?.id ?? "";

/**
 * Starting metadata for a track and format: the content package's copy for
 * the platform that uses this format, exactly what "Copy" offers there.
 */
export const draftMetadataFor = (
  pkg: Pick<ContentPackageView, "platforms" | "title" | "slug"> | null,
  format: RenderPresetId,
): Pick<PublishDraft, "title" | "description" | "tags" | "visibility"> => {
  const platformId = platformsForPreset(format)[0];
  const entry = pkg?.platforms.find((platform) => platform.platformId === platformId);
  const seeded = seedPublicationMetadata(
    entry ?? { title: null, description: null, caption: null, keywords: null, hashtags: null },
    pkg?.title ?? pkg?.slug ?? "",
  );
  return { title: seeded.title, description: seeded.description, tags: seeded.tags.join(", "), visibility: seeded.visibility };
};

export const parseTagInput = (text: string): string[] =>
  text.split(/[,\n]/).map(normalizeTag).filter((tag) => tag.length > 0);

export const publishRequestBody = (slug: string, draft: PublishDraft): PublishRequestBody => ({
  destination: draft.destination,
  source: { track: slug, format: draft.format, renderer: draft.renderer },
  metadata: {
    title: draft.title,
    description: draft.description,
    tags: parseTagInput(draft.tags),
    visibility: draft.visibility,
  },
});

/** Formats the chosen destination accepts; empty for a destination with no adapter. */
export const acceptedFormats = (destination: DestinationStatus | undefined): readonly RenderPresetId[] =>
  destination?.capabilities?.formats.map((format) => format.presetId) ?? [];

export const destinationOptionLabel = (destination: DestinationStatus): string =>
  destination.state === "ready"
    ? destination.displayName
    : `${destination.displayName} — ${destination.state === "not_configured" ? "not configured" : destination.implemented ? "unavailable" : "not implemented"}`;

export const planSummary = (plan: PublishPlanView): string =>
  plan.ok
    ? "Ready to publish"
    : plan.problems.map((problem) => PUBLISH_PROBLEM_LABELS[problem.reason]).filter((label, i, all) => all.indexOf(label) === i).join(" · ");

export const JOB_STATE_LABELS: Record<PublishJobState, string> = {
  pending: "Pending",
  validating: "Validating",
  ready: "Ready",
  publishing: "Publishing…",
  published: "Published",
  failed: "Failed — not published",
  cancelled: "Cancelled — not published",
  recovery_required: "Outcome uncertain — reconcile",
};
