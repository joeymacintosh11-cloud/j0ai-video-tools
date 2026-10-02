import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DELIVERY_RECEIPT_VERSION,
  type DeliveryReason,
  type DeliveryStatus,
} from "../../core/domain/delivery/deliveryPaths.ts";
import type { RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import { writeAtomicFile } from "../tracks/atomicFile.ts";
import type { ExportManifest } from "../tracks/exportManifest.ts";
import { assertDeliveryDestination } from "./deliveryDestination.ts";
import type { ExportFileFacts } from "../tracks/exportCoverage.ts";
import { trackOutputLocation } from "../tracks/trackLocations.ts";

/**
 * A small record of what was delivered where, and from which export.
 *
 * Kept beside the canonical pair under out/, not at the destination: the
 * destination may be a synced folder someone else looks at, and dropping
 * bookkeeping files into it would be rude. out/ is also already gitignored.
 *
 * The receipt exists so freshness never requires hashing a delivered video.
 * Comparing the recorded export fingerprint against the manifest's says whether
 * the source export is current. The delivered copy's size and modification
 * time are inexpensive drift signals; matching them does not prove that its
 * bytes are identical to the original delivery.
 */

export type DeliveryReceipt = {
  readonly schemaVersion: number;
  readonly slug: string;
  readonly presetId: RenderPresetId;
  /** The canonical export manifest's inputFingerprint at delivery time. */
  readonly sourceFingerprint: string;
  readonly sourceOutput: ExportManifest["output"];
  readonly destinationRoot: string;
  readonly destinationRelativePath: string;
  readonly deliveredAt: string;
  /** Size and mtime of the delivered copy; a copied-metadata replacement can evade them. */
  readonly bytes: number;
  readonly mtimeMs: number;
};

export const deliveryReceiptPath = (
  slug: string,
  presetId: RenderPresetId,
): string =>
  path.join(trackOutputLocation(slug, presetId).dir, `${presetId}.delivery.json`);

export const readDeliveryReceipt = (
  slug: string,
  presetId: RenderPresetId,
): DeliveryReceipt | null => {
  try {
    const value = JSON.parse(
      readFileSync(deliveryReceiptPath(slug, presetId), "utf8"),
    ) as DeliveryReceipt;

    const valid =
      value?.schemaVersion === DELIVERY_RECEIPT_VERSION &&
      value.slug === slug &&
      value.presetId === presetId &&
      typeof value.sourceFingerprint === "string" &&
      value.sourceOutput?.bytes > 0 &&
      Number.isFinite(value.sourceOutput.mtimeMs) && Number.isFinite(value.sourceOutput.ino) &&
      typeof value.destinationRoot === "string" &&
      typeof value.destinationRelativePath === "string" &&
      Number.isFinite(value.bytes) &&
      Number.isFinite(value.mtimeMs);

    // A malformed receipt is treated as no receipt: the delivery is reported as
    // never having happened, which is recoverable by delivering again.
    return valid ? value : null;
  } catch {
    return null;
  }
};

export const writeDeliveryReceipt = async (
  receipt: DeliveryReceipt,
  assertOwned: () => void = () => {},
): Promise<void> => {
  await writeAtomicFile(
    deliveryReceiptPath(receipt.slug, receipt.presetId),
    (handle) => handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf-8"),
    async () => assertOwned(),
  );
};

export type DeliveryState = {
  readonly status: DeliveryStatus;
  readonly reason: DeliveryReason | null;
  /** Absolute destination for this target, or null when delivery is off. */
  readonly destinationPath: string | null;
  readonly destinationRelativePath: string | null;
  readonly deliveredAt: string | null;
};

/**
 * What the destination holds for one export, derived from disk every time.
 *
 * Deliberately ordered: a delivered copy of an export that has since gone stale
 * is `outdated`, even though the copy still matches the manifest it was made
 * from, because what matters is whether the destination holds what *should*
 * ship. Re-rendering makes the canonical export current again and leaves the
 * delivery outdated until it is copied again; nothing is ever deleted to
 * express that.
 */
export const deliveryStateFor = (
  facts: ExportFileFacts,
  receipt: DeliveryReceipt | null,
  root: string | null,
  relativePath: string,
): DeliveryState => {
  if (root === null) {
    return {
      status: "not_configured",
      reason: "not_configured",
      destinationPath: null,
      destinationRelativePath: null,
      deliveredAt: null,
    };
  }

  const destinationPath = path.join(root, relativePath);
  const base = {
    destinationPath,
    destinationRelativePath: relativePath,
    deliveredAt: receipt?.deliveredAt ?? null,
  };
  const outdated = (reason: DeliveryReason): DeliveryState => ({
    ...base,
    status: "outdated",
    reason,
  });

  if (receipt === null) {
    return { ...base, status: "pending", reason: "never_delivered" };
  }

  // The configured destination, or the track's folder, changed since delivery,
  // so nothing is delivered *there* even though a copy exists somewhere else.
  if (
    receipt.destinationRoot !== root ||
    receipt.destinationRelativePath !== relativePath
  ) {
    return outdated("destination_changed");
  }

  try {
    assertDeliveryDestination(root, relativePath);
    const stats = lstatSync(destinationPath);
    if (!stats.isFile() || stats.size !== receipt.bytes || stats.mtimeMs !== receipt.mtimeMs) {
      return outdated("destination_modified");
    }
  } catch {
    return outdated("destination_missing");
  }

  if (!facts.rendered) return outdated("export_missing");
  if (facts.freshness !== "current") return outdated("export_not_current");
  if (facts.inputFingerprint !== receipt.sourceFingerprint ||
      facts.outputIdentity?.ino !== receipt.sourceOutput.ino ||
      facts.outputIdentity?.bytes !== receipt.sourceOutput.bytes ||
      facts.outputIdentity?.mtimeMs !== receipt.sourceOutput.mtimeMs) {
    return outdated("export_changed");
  }

  return { ...base, status: "delivered", reason: null };
};
