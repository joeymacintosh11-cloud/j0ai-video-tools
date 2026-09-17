const PUBLIC_PREFIX = "public/";

/**
 * Maps a `public/`-relative path reported by the API onto the URL the dev
 * server actually serves it at.
 *
 * Vite's publicDir is the project's public/ folder, so its contents are served
 * from the web root: "public/tracks/x/cover.png" on disk is "/tracks/x/cover.png"
 * over HTTP. This is the one place that conversion happens — the UI never
 * assembles a track path itself, it only re-bases one the API gave it.
 */
export const publicAssetUrl = (label: string, version?: number): string => {
  const relative = label.startsWith(PUBLIC_PREFIX)
    ? label.slice(PUBLIC_PREFIX.length)
    : label;

  // A re-uploaded file keeps its path, so the browser would serve the cached
  // copy. `version` is bumped only after an upload — not on every refresh, so
  // an unchanged cover is still served from cache.
  return version ? `/${relative}?v=${version}` : `/${relative}`;
};
