import { createHash, randomUUID } from "node:crypto";
import {
  DELIVERY_LOG_SCHEMA_VERSION,
  deliveryIdText,
  type DeliveryLogEvent,
  type DeliveryLogEventSource,
  type DeliveryLogTrack,
} from "../../src/domain/delivery/deliveryHistory.ts";
import type { TrackMetadata } from "../../src/domain/tracks/types.ts";
import { RENDER_PRESETS } from "../../src/domain/video/renderPresets.ts";
import { appendDeliveryLogEvent } from "./deliveryHistoryLog.ts";
import type { DeliveryReceipt } from "./deliveryReceipt.ts";

/**
 * Builds the history event for a completed delivery, and records it.
 *
 * Everything in an event comes from state the server already holds and trusts:
 * the committed delivery receipt (what was copied, when, how big, and from
 * which canonical export), the track's metadata as read from disk under the
 * target lock, and the preset definition. Nothing is taken from a request body
 * or from the browser, and no caller may supply an event — the shape of history
 * is decided here.
 *
 * A history entry is a *snapshot*. Renaming a track or changing its BPM later
 * does not reach back into what has already been written, which is the whole
 * point of keeping this separate from the release bundle: one says what is
 * true now, this says what was true then.
 */

const hash = (text: string): string =>
  createHash("sha256").update(text).digest("hex");

/** The exact canonical file a delivery was made from, as a short identity. */
const sourceOutputOf = (receipt: DeliveryReceipt): string =>
  `${receipt.sourceOutput.ino}:${receipt.sourceOutput.bytes}:${receipt.sourceOutput.mtimeMs}`;

/**
 * Identity of one completed delivery, derived only from its receipt.
 *
 * Stable, so appending the same completion twice is detectable — and computed
 * the same way by delivery and by reconciliation, which is what lets
 * reconciliation tell "this is already recorded" from "this was never
 * recorded". Delivering the same export again produces a new receipt with a new
 * timestamp and a new file modification time, so it is a different delivery and
 * correctly gets its own event.
 */
export const deliveryIdForReceipt = (receipt: DeliveryReceipt): string =>
  hash(
    deliveryIdText({
      slug: receipt.slug,
      presetId: receipt.presetId,
      path: receipt.destinationRelativePath,
      deliveredAt: receipt.deliveredAt,
      bytes: receipt.bytes,
      mtimeMs: receipt.mtimeMs,
      exportFingerprint: receipt.sourceFingerprint,
      sourceOutput: sourceOutputOf(receipt),
    }),
  );

const trackSnapshot = (
  slug: string,
  metadata: TrackMetadata,
): DeliveryLogTrack => ({
  slug,
  title: metadata.title,
  artist: metadata.artist,
  key: metadata.key,
  bpm: metadata.bpm,
  ...(metadata.subtitle ? { subtitle: metadata.subtitle } : {}),
});

/**
 * The event for a receipt, with the metadata snapshot the caller vouches for.
 *
 * The preset is written out in full rather than referenced by id, so history
 * stays readable after a preset is renamed or retired.
 */
export const deliveryEventFor = (
  receipt: DeliveryReceipt,
  metadata: TrackMetadata,
  source: DeliveryLogEventSource,
): DeliveryLogEvent => {
  const preset = RENDER_PRESETS[receipt.presetId];

  return {
    schemaVersion: DELIVERY_LOG_SCHEMA_VERSION,
    eventId: randomUUID(),
    kind: "delivery",
    source,
    deliveredAt: receipt.deliveredAt,
    track: trackSnapshot(receipt.slug, metadata),
    preset: {
      id: receipt.presetId,
      label: preset.shortLabel,
      width: preset.width,
      height: preset.height,
      fps: preset.fps,
    },
    // Relative to the destination root the log itself sits in, so an event
    // carries no machine-local path.
    path: receipt.destinationRelativePath,
    bytes: receipt.bytes,
    exportFingerprint: receipt.sourceFingerprint,
    deliveryId: deliveryIdForReceipt(receipt),
  };
};

export type RecordDeliveryResult = {
  /** Null when nothing was written, whether or not that was a problem. */
  readonly eventId: string | null;
  /** True when this completion was already recorded, so nothing was added. */
  readonly duplicate: boolean;
  readonly problem: string | null;
};

/**
 * Records one completed delivery in the destination's log.
 *
 * Called only after the copy has been published atomically and its receipt has
 * been committed, so an event can never describe a delivery that did not
 * happen. The converse is the honest transaction boundary and is documented
 * where it matters: a crash between the receipt and this append leaves a real
 * delivery with no event, which reconciliation can put right from the receipt.
 *
 * Never throws, and never changes the delivery's result.
 */
export const recordDelivery = async ({
  root,
  receipt,
  metadata,
}: {
  readonly root: string;
  readonly receipt: DeliveryReceipt;
  readonly metadata: TrackMetadata;
}): Promise<RecordDeliveryResult> => {
  try {
    const event = deliveryEventFor(receipt, metadata, "delivery");
    const result = await appendDeliveryLogEvent(root, event);

    return {
      eventId: result.appended ? event.eventId : null,
      duplicate: result.duplicate,
      problem: result.problem,
    };
  } catch (error) {
    return {
      eventId: null,
      duplicate: false,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
};
