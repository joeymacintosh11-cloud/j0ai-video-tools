import type { ServerResponse } from "node:http";

const HEARTBEAT_INTERVAL_MS = 15000;

export type SseStream = {
  readonly send: (event: string, data: unknown) => void;
  readonly close: () => void;
  readonly onClose: (listener: () => void) => void;
};

/**
 * Minimal Server-Sent Events stream.
 *
 * A comment heartbeat keeps intermediaries and idle sockets from dropping the
 * connection during the quiet stretches of a render (notably the one-time
 * audio decode before the first frame lands).
 */
export const openSseStream = (response: ServerResponse): SseStream => {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });

  // Flush headers immediately so clients see an open stream right away.
  response.write(": connected\n\n");

  const heartbeat = setInterval(() => {
    if (!response.writableEnded) {
      response.write(": ping\n\n");
    }
  }, HEARTBEAT_INTERVAL_MS);
  heartbeat.unref();

  let closed = false;
  const closeListeners: (() => void)[] = [];

  const finish = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearInterval(heartbeat);
    for (const listener of closeListeners) {
      listener();
    }
  };

  response.on("close", finish);

  return {
    send: (event, data) => {
      if (closed || response.writableEnded) {
        return;
      }
      response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close: () => {
      finish();
      if (!response.writableEnded) {
        response.end();
      }
    },
    onClose: (listener) => {
      if (closed) {
        listener();
        return;
      }
      closeListeners.push(listener);
    },
  };
};
