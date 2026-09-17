import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Dev server for the local Toshi Visualizer UI (Phase 2C).
 *
 * The Vite root is the project root rather than ui/, deliberately:
 *
 *  - publicDir then defaults to public/ — the same folder Remotion serves. The
 *    composition calls staticFile() on paths like "tracks/x/cover.png", which
 *    resolve to "/tracks/x/cover.png", so <Player> preview art and audio load
 *    with no extra configuration and no path rewriting.
 *  - ui/ can import src/BeatVisualizer and src/domain directly, because both
 *    sit inside the Vite root.
 *
 * /api is proxied to the Phase 2B API server, so the browser only ever talks to
 * a single origin. That is the reason the API server needs no CORS handling.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    // Loopback only, matching the API server's own binding. Vite would
    // otherwise resolve "localhost" to IPv6 only, so 127.0.0.1 would refuse
    // connections.
    host: "127.0.0.1",
    port: 5174,
    strictPort: true,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4600",
        changeOrigin: false,
        // No WebSocket upgrade: render progress is Server-Sent Events, which
        // the proxy streams as ordinary chunked HTTP (verified — events arrive
        // incrementally, not buffered).
        ws: false,
      },
    },
  },
});
