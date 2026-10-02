import { TrackError, trackIssue } from "../tracks/errors.ts";
import { RENDER_PRESET_LIST, type RenderPresetId } from "../video/renderPresets.ts";

/**
 * The social platforms a content package can target, defined once.
 *
 * Pure and dependency-free, exactly like `renderPresets.ts`: the server, the
 * CLI and the UI all read the same mapping instead of repeating it. A platform
 * is not a new rendering format — each one names an existing render preset, so
 * adding a platform here never means teaching the composition a new shape.
 *
 * A fourth platform sharing a preset another platform already uses (say, a
 * second square-format destination) is deliberately supported: nothing here
 * assumes the mapping from platform to preset is one-to-one, only that a
 * platform names exactly one preset.
 */

export const PLATFORM_IDS = ["youtube", "reels", "instagram-square"] as const;

export type PlatformId = (typeof PLATFORM_IDS)[number];

export type PlatformProfile = {
  readonly id: PlatformId;
  readonly label: string;
  readonly presetId: RenderPresetId;
  /**
   * Short, filesystem-safe word used to build a platform-facing filename
   * alias, e.g. "ghetto-geek-youtube.mp4". Never the name of an actual
   * canonical render or delivery file — those keep their existing naming
   * (out/<slug>/<preset>.mp4, and <slug>-<preset-id>.mp4 at a delivery
   * destination). This is a descriptive alias only, for metadata and
   * generated text, so nothing here can collide with or rename a real file.
   */
  readonly filenameSuffix: string;
  /** Whether this platform's metadata includes a long-form description. */
  readonly supportsDescription: boolean;
  /** Whether this platform's metadata is a short caption instead. */
  readonly supportsCaption: boolean;
};

export const PLATFORM_PROFILES: Record<PlatformId, PlatformProfile> = {
  youtube: {
    id: "youtube",
    label: "YouTube",
    presetId: "youtube-16x9",
    filenameSuffix: "youtube",
    supportsDescription: true,
    supportsCaption: false,
  },
  reels: {
    id: "reels",
    label: "Reels / TikTok",
    presetId: "vertical-9x16",
    filenameSuffix: "reels",
    supportsDescription: false,
    supportsCaption: true,
  },
  "instagram-square": {
    id: "instagram-square",
    label: "Instagram Square",
    presetId: "square-1x1",
    filenameSuffix: "square",
    supportsDescription: false,
    supportsCaption: true,
  },
};

export const PLATFORM_LIST: readonly PlatformProfile[] = PLATFORM_IDS.map(
  (id) => PLATFORM_PROFILES[id],
);

export const isPlatformId = (value: unknown): value is PlatformId =>
  typeof value === "string" &&
  (PLATFORM_IDS as readonly string[]).includes(value);

export const assertPlatformId = (value: unknown): PlatformId => {
  if (!isPlatformId(value)) {
    throw new TrackError(
      trackIssue(
        "INVALID_PLATFORM",
        `Unknown platform ${JSON.stringify(value)}. Expected one of: ${PLATFORM_IDS.join(", ")}.`,
      ),
    );
  }
  return value;
};

/** Canonical order, duplicates dropped — mirrors canonicalPresetOrder(). */
export const canonicalPlatformOrder = (
  ids: Iterable<PlatformId>,
): readonly PlatformId[] => {
  const wanted = new Set(ids);
  return PLATFORM_IDS.filter((id) => wanted.has(id));
};

/** The platform(s) built on a given preset, in canonical platform order. */
export const platformsForPreset = (
  presetId: RenderPresetId,
): readonly PlatformId[] =>
  PLATFORM_LIST.filter((profile) => profile.presetId === presetId).map(
    (profile) => profile.id,
  );

/**
 * The descriptive, platform-facing filename alias for a track's export.
 *
 * Never written to disk by anything in this module — it exists only for
 * generated text (titles, manifests, metadata files) where a reader benefits
 * from a name like "ghetto-geek-youtube.mp4" rather than the canonical
 * "youtube-16x9.mp4" or delivery's "ghetto-geek-youtube-16x9.mp4".
 */
export const platformFilename = (slug: string, platformId: PlatformId): string =>
  `${slug}-${PLATFORM_PROFILES[platformId].filenameSuffix}.mp4`;

/** Every preset id any platform profile maps to, deduplicated. */
export const PACKAGE_PRESET_IDS: readonly RenderPresetId[] =
  RENDER_PRESET_LIST.map((preset) => preset.id).filter((id) =>
    PLATFORM_LIST.some((profile) => profile.presetId === id),
  );
