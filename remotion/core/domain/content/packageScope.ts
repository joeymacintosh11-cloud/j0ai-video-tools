import type { PlatformId } from "./platformProfiles.ts";

/**
 * What the single-track Content Package picker (ContentPackagePanel.tsx)
 * should check the first time an operator switches into Custom this
 * session — never reapplied while a Custom selection already exists, so a
 * choice already made survives switching away and back (Intent/Full and
 * back to Custom).
 *
 * Intent's initial set is exactly the platforms Intent mode itself currently
 * resolves (each platform whose preset the track's own exportPresets already
 * intends), so switching Intent → Custom never looks like Custom silently
 * started somewhere else. Full's initial set is every supported platform,
 * for the same reason.
 */
export type PackageScopeMode = "intent" | "full";

export const initialCustomPlatforms = (
  fromMode: PackageScopeMode,
  intentPlatformIds: readonly PlatformId[],
  fullPlatformIds: readonly PlatformId[],
): readonly PlatformId[] => (fromMode === "full" ? fullPlatformIds : intentPlatformIds);
