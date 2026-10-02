import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import {
  appendDeliveryLogEvent,
  repairDeliveryLogTail,
} from "../services/delivery/deliveryHistoryLog.ts";
import { DELIVERY_LOG_SCHEMA_VERSION } from "../core/domain/delivery/deliveryHistory.ts";

/**
 * A separate process that contends for the delivery log's append lock.
 *
 * Separate from `history-process.mts`, which only appends: the claims here are
 * about what happens when an appender meets a *holder* or a *repairer*, and
 * those need something that can be told when to let go.
 *
 *   argv: <destination root> <mode> [marker]
 *
 * - `hold`   creates the lock naming this live process and waits to be told to
 *            drop it. This is what a real holder looks like from outside, and a
 *            live owner is exactly the case that must never be stolen.
 * - `repair` runs the tail repair on command, which takes the same lock.
 * - `append` appends one event on command.
 */

const [root, mode, marker = "x"] = process.argv.slice(2);
const lock = path.join(root, ".delivery-log.lock");

const event = () => ({
  schemaVersion: DELIVERY_LOG_SCHEMA_VERSION,
  eventId: randomUUID(),
  kind: "delivery" as const,
  source: "delivery" as const,
  deliveredAt: "2026-09-18T12:00:00.000Z",
  track: { slug: "probe", title: "Probe", artist: "Toshi", key: "F Minor", bpm: 100 },
  preset: {
    id: "youtube-16x9",
    label: "YouTube 16:9",
    width: 1920,
    height: 1080,
    fps: 30,
  },
  path: "Probe/probe-youtube-16x9.mp4",
  bytes: 1_000,
  exportFingerprint: "f".repeat(64),
  deliveryId: marker,
});

if (mode === "hold") {
  writeFileSync(
    lock,
    JSON.stringify({
      pid: process.pid,
      hostname: hostname(),
      token: `held-${marker}`,
      createdAt: new Date().toISOString(),
    }),
  );
}

process.send?.({ type: "ready" });

process.on("message", (message) => {
  if (message === "release" && mode === "hold") {
    try {
      unlinkSync(lock);
    } catch {
      // Someone cleared it already, which is what the test may be checking.
    }
    process.send?.({ type: "released" });
    process.disconnect();
    return;
  }

  if (message !== "go") return;

  void (async () => {
    const result =
      mode === "repair"
        ? await repairDeliveryLogTail(root)
        : await appendDeliveryLogEvent(root, event());

    process.send?.({ type: "done", result });
    process.disconnect();
  })();
});
