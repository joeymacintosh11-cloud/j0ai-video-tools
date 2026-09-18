import { randomUUID } from "node:crypto";
import {
  DELIVERY_LOG_SCHEMA_VERSION,
  type DeliveryLogEvent,
} from "../src/domain/delivery/deliveryHistory.ts";
import { appendDeliveryLogEvent } from "../services/delivery/deliveryHistoryLog.ts";

/**
 * A separate process that appends to a destination's delivery log.
 *
 * Real processes, because the claim being tested is about processes: an
 * in-process mutex would make any number of "concurrent" appends pass while
 * saying nothing at all about two `npm run deliver-track` runs, or the server
 * and the CLI, hitting the same log at once.
 *
 *   argv: <destination root> <marker> <how many events>
 *
 * It reports when it is ready, waits to be told to go so that every appender
 * starts at the same moment, and reports what it managed to append.
 */

const [root, marker, countArgument] = process.argv.slice(2);
const count = Number(countArgument);

const event = (index: number): DeliveryLogEvent => ({
  schemaVersion: DELIVERY_LOG_SCHEMA_VERSION,
  eventId: randomUUID(),
  kind: "delivery",
  source: "delivery",
  deliveredAt: new Date(Date.UTC(2026, 8, 18, 12, 0, index)).toISOString(),
  track: {
    slug: "probe",
    // Padded out so a line is a realistic size rather than a tiny one that
    // would land atomically by accident.
    title: `Probe ${marker} ${"-".repeat(120)}`,
    artist: "Toshi",
    key: "F Minor",
    bpm: 100,
  },
  preset: {
    id: "youtube-16x9",
    label: "YouTube 16:9",
    width: 1920,
    height: 1080,
    fps: 30,
  },
  path: `Probe/probe-youtube-16x9.mp4`,
  bytes: 1_000 + index,
  exportFingerprint: "f".repeat(64),
  // Unique per appender and per event, so the duplicate check never suppresses
  // one of these and every append is expected to land.
  deliveryId: `${marker}-${index}`,
});

process.send?.({ type: "ready" });

process.on("message", (message) => {
  if (message !== "go") return;

  void (async () => {
    const appended: string[] = [];
    const problems: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const result = await appendDeliveryLogEvent(root, event(index));
      if (result.appended) appended.push(`${marker}-${index}`);
      else problems.push(result.problem ?? "not appended");
    }

    process.send?.({ type: "done", appended, problems });
    process.disconnect();
  })();
});
