import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { copyFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import {
  deliveryRelativePath,
  type DeliveryReason,
  type DeliveryStatus,
} from "../../src/domain/delivery/deliveryPaths.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import type { TrackMetadata } from "../../src/domain/tracks/types.ts";
import {
  assertRenderPresetId,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import { trackExportCoverage } from "../tracks/exportCoverage.ts";
import { outputIdentity } from "../tracks/exportManifest.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import {
  deliveryStateFor,
  readDeliveryReceipt,
  writeDeliveryReceipt,
  type DeliveryReceipt,
} from "./deliveryReceipt.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "./deliverySettings.ts";

/**
 * Copies one finished export to the configured destination.
 *
 * Delivery is strictly downstream of the canonical render. `out/` stays the
 * source of truth: the canonical file is never moved, the destination copy is
 * never consulted for freshness, and a delivery that fails leaves a
 * successfully rendered export completely untouched. "Render: current,
 * delivery: failed" is a real and reportable state.
 *
 * Only a *current* export is delivered. Copying a stale one would put content
 * at the destination that the tool already knows should be re-rendered.
 *
 * The copy is published atomically: a temp file inside the destination
 * directory, then a rename. A viewer of that folder never sees a partial video,
 * and the previously delivered file survives until the new one is complete.
 *
 * Racing with a replacement render is handled by re-checking the export's
 * identity after the copy rather than by holding the render lock for the whole
 * copy. A rename into place swaps a directory entry, so an in-progress read
 * keeps the version it opened — the bytes copied are always one coherent
 * export — and if the export changed underneath, that copy is discarded
 * instead of published.
 */

export type DeliveryOutcome = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly label: string;
  readonly status: DeliveryStatus;
  readonly reason: DeliveryReason | null;
  readonly destinationPath: string | null;
  readonly destinationRelativePath: string | null;
  readonly bytes: number | null;
  /** Human-readable explanation when a delivery did not happen. */
  readonly message: string | null;
};

export type DeliverExportInput = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  /** Read once by a caller delivering several targets. */
  readonly settings?: DeliverySettings;
  /**
   * The track's metadata, when the caller already has it. Omitted means read it
   * here — it decides the destination folder, so it must never be skipped.
   */
  readonly metadata?: TrackMetadata | null;
};

const outcome = (
  slug: string,
  presetId: RenderPresetId,
  label: string,
  partial: Partial<DeliveryOutcome>,
): DeliveryOutcome => ({
  slug,
  presetId,
  label,
  status: "failed",
  reason: null,
  destinationPath: null,
  destinationRelativePath: null,
  bytes: null,
  message: null,
  ...partial,
});

/**
 * Delivers one target, reporting rather than throwing.
 *
 * A delivery problem is an outcome, not an exception: a catalogue run must be
 * able to deliver nine of ten targets and tell you about the tenth. Invalid
 * *input* — a bad slug or preset — still throws, because that is a programming
 * or request error rather than a state of the world.
 */
export const deliverExport = async ({
  slug: slugInput,
  presetId: presetInput,
  settings,
  metadata: providedMetadata,
}: DeliverExportInput): Promise<DeliveryOutcome> => {
  const slug = assertValidSlug(slugInput);
  const presetId = assertRenderPresetId(presetInput);
  const resolved = settings ?? (await readDeliverySettings());
  const { root, problem } = resolveDeliveryRoot(resolved);

  // Resolved rather than defaulted: deliveryFolder lives in metadata, so a
  // caller that omits it must still deliver into the track's chosen folder.
  const metadata =
    providedMetadata === undefined
      ? (await inspectTrack(slug)).metadata
      : providedMetadata;

  const facts = trackExportCoverage(slug, metadata).find(
    (entry) => entry.presetId === presetId,
  );
  const label = facts?.label ?? presetId;

  if (root === null) {
    return outcome(slug, presetId, label, {
      status: problem === null ? "not_configured" : "failed",
      reason: problem === null ? "not_configured" : "copy_failed",
      message:
        problem ??
        "No export destination is configured, so there is nowhere to deliver to.",
    });
  }

  const relativePath = deliveryRelativePath(
    slug,
    presetId,
    metadata?.deliveryFolder,
  );
  const destinationPath = path.join(root, relativePath);

  // Belt and braces after validating the slug, preset and folder separately:
  // whatever they are, the destination must be inside the configured root.
  if (!path.resolve(destinationPath).startsWith(`${path.resolve(root)}${path.sep}`)) {
    return outcome(slug, presetId, label, {
      reason: "copy_failed",
      message: `Refusing to deliver outside the export destination ${root}.`,
    });
  }

  const common = { destinationPath, destinationRelativePath: relativePath };

  if (facts === undefined || !facts.rendered) {
    return outcome(slug, presetId, label, {
      ...common,
      status: "pending",
      reason: "export_missing",
      message: `Nothing to deliver: ${facts?.outputLabel ?? presetId} has not been rendered.`,
    });
  }

  if (facts.freshness !== "current") {
    return outcome(slug, presetId, label, {
      ...common,
      status: "outdated",
      reason: "export_not_current",
      message: `${facts.outputLabel} is ${facts.freshness}, so it is not delivered. Re-render it first.`,
    });
  }

  // The export we intend to copy, identified precisely enough to notice a
  // replacement publishing underneath us.
  const before = (() => {
    try {
      return {
        identity: outputIdentity(facts.outputPath),
        fingerprint: facts.inputFingerprint,
      };
    } catch {
      return null;
    }
  })();

  if (before === null || before.fingerprint === null) {
    return outcome(slug, presetId, label, {
      ...common,
      reason: "export_missing",
      message: `Could not read ${facts.outputLabel} to deliver it.`,
    });
  }

  const directory = path.dirname(destinationPath);
  const staged = path.join(directory, `.deliver-${randomUUID()}.mp4.tmp`);

  try {
    // Inside the configured root only; the containment check above is what
    // makes creating this safe.
    await mkdir(directory, { recursive: true });
    await copyFile(facts.outputPath, staged);

    // Re-read freshness from disk: a replacement render may have published
    // between the checks above and the copy finishing.
    const after = trackExportCoverage(slug, metadata).find(
      (entry) => entry.presetId === presetId,
    );
    const identity = statSync(facts.outputPath);

    if (
      after?.freshness !== "current" ||
      after.inputFingerprint !== before.fingerprint ||
      identity.ino !== before.identity.ino ||
      identity.size !== before.identity.bytes ||
      identity.mtimeMs !== before.identity.mtimeMs
    ) {
      return outcome(slug, presetId, label, {
        ...common,
        reason: "source_changed",
        message: `${facts.outputLabel} changed while it was being delivered, so the copy was discarded. Deliver again.`,
      });
    }

    // Only now is the previous delivered file replaced, in one atomic step.
    await rename(staged, destinationPath);

    const delivered = statSync(destinationPath);
    const receipt: DeliveryReceipt = {
      schemaVersion: 1,
      slug,
      presetId,
      sourceFingerprint: before.fingerprint,
      destinationRoot: root,
      destinationRelativePath: relativePath,
      deliveredAt: new Date().toISOString(),
      bytes: delivered.size,
      mtimeMs: delivered.mtimeMs,
    };
    await writeDeliveryReceipt(receipt);

    return outcome(slug, presetId, label, {
      ...common,
      status: "delivered",
      bytes: delivered.size,
    });
  } catch (error) {
    return outcome(slug, presetId, label, {
      ...common,
      reason: "copy_failed",
      message: `Could not deliver ${facts.outputLabel}: ${error instanceof Error ? error.message : String(error)}`,
    });
  } finally {
    // Never leaves a half-copied video behind. Removing the staged file after a
    // successful rename is a no-op, which keeps this path unconditional.
    await rm(staged, { force: true });
  }
};

/** Current delivery state for one target, without delivering anything. */
export const deliveryStateForTarget = (
  slug: string,
  presetId: RenderPresetId,
  facts: Parameters<typeof deliveryStateFor>[0],
  root: string | null,
  deliveryFolder: string | null | undefined,
) =>
  deliveryStateFor(
    facts,
    readDeliveryReceipt(slug, presetId),
    root,
    deliveryRelativePath(slug, presetId, deliveryFolder),
  );
