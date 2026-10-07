import type {
  ContentPackageView,
  PublicationDraftFields,
  PublicationDraftView,
  TrackSummaryView,
} from "../../core/domain/api/views.ts";
import { normalizeTag } from "../../core/domain/publishing/publicationMetadata.ts";
import {
  DRAFT_PLATFORMS,
  DRAFT_PLATFORM_RULES,
  type DraftPlatform,
  type DraftStatus,
} from "../../core/domain/publishing/publicationDraft.ts";
import { PUBLISH_PROBLEM_LABELS } from "../../core/domain/publishing/publishProblems.ts";
import type { ExportFreshness } from "../../core/domain/video/exportFreshness.ts";
import type { RendererId } from "../../core/domain/video/renderers.ts";
import type { RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import { draftMetadataFor } from "./publishModel.ts";

/**
 * Pure state for the Publishing dashboard. The server decides whether a
 * draft may be marked ready; this only lists assets, builds requests and
 * labels answers.
 */

/** One rendered export a draft can be written for. */
export type ExportedAsset = {
  readonly slug: string;
  readonly title: string;
  readonly format: RenderPresetId;
  readonly label: string;
  /** The track's preferred renderer: the only one whose exports its views judge. */
  readonly renderer: RendererId;
  readonly freshness: ExportFreshness;
};

/** Every rendered export of every track, from the track list's own export facts. */
export const exportedAssets = (tracks: readonly TrackSummaryView[]): readonly ExportedAsset[] =>
  tracks.flatMap((track) =>
    track.exports
      .filter((output) => output.present)
      .map((output) => ({
        slug: track.slug,
        title: track.title ?? track.slug,
        format: output.presetId,
        label: output.label,
        renderer: track.exportsRenderer,
        freshness: output.freshness,
      })),
  );

/** Platforms whose drafts take this format, in canonical order. */
export const platformsForFormat = (format: RenderPresetId): readonly DraftPlatform[] =>
  DRAFT_PLATFORMS.filter((platform) => DRAFT_PLATFORM_RULES[platform].formats.includes(format));

/** What the editor holds; hashtags as typed. */
export type DraftForm = {
  readonly platform: DraftPlatform;
  readonly track: string;
  readonly format: RenderPresetId;
  readonly renderer: RendererId;
  readonly title: string;
  readonly description: string;
  readonly hashtags: string;
  readonly status: DraftStatus;
};

/** "#lofi #beats, chill" -> ["lofi", "beats", "chill"]. A hashtag is one word. */
export const parseHashtagInput = (text: string): string[] =>
  text.split(/[\s,]+/).map(normalizeTag).filter((tag) => tag.length > 0);

export const formatHashtags = (tags: readonly string[]): string => tags.map((tag) => `#${tag}`).join(" ");

/**
 * A new draft for an asset, seeded with the content package's copy for that
 * format — the same text the Publish panel and "Copy" start from. Package
 * keywords may be phrases; as hashtags their spaces and punctuation are dropped.
 */
export const newDraftForm = (
  asset: Pick<ExportedAsset, "slug" | "format" | "renderer">,
  pkg: Pick<ContentPackageView, "platforms" | "title" | "slug"> | null,
): DraftForm => {
  const seeded = draftMetadataFor(pkg, asset.format);
  // Platforms end a hashtag at the first character that is not a letter,
  // digit or underscore, so "#a-minor" would post as "#a".
  const tags = seeded.tags
    .split(",")
    .map((tag) => tag.replace(/[^\p{L}\p{N}_]/gu, ""))
    .filter((tag) => tag.length > 0);
  return {
    platform: platformsForFormat(asset.format)[0] ?? "youtube",
    track: asset.slug,
    format: asset.format,
    renderer: asset.renderer,
    title: seeded.title,
    description: seeded.description,
    hashtags: formatHashtags([...new Set(tags)]),
    status: "draft",
  };
};

export const formFromDraft = ({ draft }: PublicationDraftView): DraftForm => ({
  platform: draft.platform,
  track: draft.source.track,
  format: draft.source.format,
  renderer: draft.source.renderer,
  title: draft.title,
  description: draft.description,
  hashtags: formatHashtags(draft.hashtags),
  status: draft.status,
});

export const draftFields = (form: DraftForm): PublicationDraftFields => ({
  platform: form.platform,
  source: { track: form.track, format: form.format, renderer: form.renderer },
  title: form.title,
  description: form.description,
  hashtags: parseHashtagInput(form.hashtags),
  status: form.status,
});

/** One line for a draft's readiness, as the server judged it. */
export const readinessSummary = (view: PublicationDraftView): string =>
  view.problems.length === 0
    ? "Nothing blocking"
    : [...new Set(view.problems.map((problem) => PUBLISH_PROBLEM_LABELS[problem.reason]))].join(" · ");
