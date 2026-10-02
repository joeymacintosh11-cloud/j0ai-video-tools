import { createServer } from "node:http";
import { handleRequest } from "./app.ts";
import { renderManager } from "../services/workflows/renderManager.ts";

/**
 * Local-only API server for the Toshi visualizer.
 *
 * Binds to 127.0.0.1 exclusively — this is a tool on one machine, with no
 * auth and no remote surface. Port 4600 stays clear of 3000-3100, which
 * Remotion Studio and Remotion's own internal render server use.
 */
const HOST = "127.0.0.1";
const DEFAULT_PORT = 4600;

const port = Number.parseInt(process.env.TOSHI_API_PORT ?? "", 10) || DEFAULT_PORT;

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    // Last-resort boundary, including a failure while writing an error response.
    console.error("[api] request handler failed:", error);
    response.destroy();
  });
});

server.listen(port, HOST, () => {
  console.log(`Toshi visualizer API listening on http://${HOST}:${port}`);
  console.log(`  GET  http://${HOST}:${port}/api/health`);
  console.log(`  GET  http://${HOST}:${port}/api/tracks`);
});

server.on("error", (error) => {
  console.error("[api] server error:", error);
  process.exitCode = 1;
});

let shuttingDown = false;

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  console.log(`\n[api] ${signal} received — shutting down.`);

  // Stop taking new connections first, then stop in-flight render work so a
  // Chromium process is never left behind.
  server.close();

  try {
    await renderManager.shutdown();
  } catch (error) {
    console.error("[api] error while cancelling active render:", error);
  }

  // closeAllConnections also ends open SSE streams.
  server.closeAllConnections();
  console.log("[api] shutdown complete.");
  process.exit(0);
};

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
