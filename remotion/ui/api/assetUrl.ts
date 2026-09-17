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
export const publicAssetUrl = (label: string): string => {
  const relative = label.startsWith(PUBLIC_PREFIX)
    ? label.slice(PUBLIC_PREFIX.length)
    : label;

  return `/${relative}`;
};
