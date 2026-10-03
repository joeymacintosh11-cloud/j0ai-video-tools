import { statSync } from "node:fs";
import {
  deliveryRelativePath,
  type DeliveryReason,
  type DeliveryStatus,
} from "../../core/domain/delivery/deliveryPaths.ts";
import { TrackError } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import {
  assertRenderPresetId,
  RENDER_PRESETS,
  type RenderPresetId,
} from "../../core/domain/video/renderPresets.ts";
import {
  remotionOnlyProblem,
  resolveTrackRenderer,
} from "../../core/domain/video/renderers.ts";
import { trackExportCoverage } from "../tracks/exportCoverage.ts";
import { outputIdentity } from "../tracks/exportManifest.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { withRenderTargetLock, type RenderTargetLock } from "../render/renderLock.ts";
import { assertDeliveryDestination } from "./deliveryDestination.ts";
import { recordDelivery } from "./deliveryHistory.ts";
import { stageDelivery } from "./stageDelivery.ts";
import { DELIVERY_RECEIPT_VERSION } from "../../core/domain/delivery/deliveryPaths.ts";
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
 * The target lock is held for the whole delivery, so canonical publication and
 * other deliveries of the same export are excluded from start to receipt.
 * Destination writes run in a directory pinned by a helper's working directory,
 * and live metadata is read again before the staged copy may be published.
 *
 * A successful delivery is then appended to the destination's delivery log, in
 * that order and never before: file published, receipt committed, history
 * recorded. Recording is the last step and the only one that cannot undo
 * anything, so a log that could not be written is reported alongside a
 * delivery that still succeeded.
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
  /** The history event this delivery was recorded as, when it was. */
  readonly historyEventId: string | null;
  /**
   * Why the delivery was not recorded in the destination's log, if it was not.
   * Never a delivery failure: the file is published and its receipt committed,
   * so "delivered, not logged" is a real state and is reported as one.
   */
  readonly historyProblem: string | null;
};

export type DeliverExportInput = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  /** Read once by a caller delivering several targets. */
  readonly settings?: DeliverySettings;
};

/**
 * Deliberately no metadata input.
 *
 * The delivery folder comes from metadata, so it decides where bytes are
 * written — and a caller's snapshot can be arbitrarily old by the time a copy
 * is published. Execution reads it from disk itself, under the target lock, and
 * re-reads it before publishing. A planner's view is for display and planning,
 * never authority.
 */

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
  historyEventId: null,
  historyProblem: null,
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
const deliverOwnedExport = async ({
  slug: slugInput,
  presetId: presetInput,
  settings,
}: DeliverExportInput, lock: RenderTargetLock): Promise<DeliveryOutcome> => {
  const slug = assertValidSlug(slugInput);
  const presetId = assertRenderPresetId(presetInput);
  const resolved = settings ?? (await readDeliverySettings());
  const { root } = resolveDeliveryRoot(resolved);

  // Execution always reads live metadata; planner snapshots are never authority.
  const metadata = (await inspectTrack(slug)).metadata;

  const facts = trackExportCoverage(slug, metadata).find(
    (entry) => entry.presetId === presetId,
  );
  const label = facts?.label ?? presetId;

  // Delivery copies Remotion's export. For a track that prefers another
  // renderer that would ship a video the track did not ask for, so it is
  // refused here — whatever started it: the Deliver panel, auto-delivery, a
  // fix plan or a content package.
  const rendererProblem = remotionOnlyProblem(
    resolveTrackRenderer(metadata?.renderer),
    "Delivery",
  );
  if (rendererProblem !== null) {
    return outcome(slug, presetId, label, {
      status: "failed",
      reason: "renderer_not_supported",
      message: rendererProblem,
    });
  }

  // Checked again before locking, but re-checked here because the root is
  // re-resolved from disk and could have gone away in between.
  if (root === null) {
    return outcome(slug, presetId, label, {
      status: "failed",
      reason: "copy_failed",
      message: "The export destination is no longer available.",
    });
  }

  const relativePath = deliveryRelativePath(
    slug,
    presetId,
    metadata?.deliveryFolder,
  );
  const destinationPath = assertDeliveryDestination(root, relativePath);

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

  const staged = await stageDelivery(root, relativePath, facts.outputPath);
  try {
    // Re-read freshness from disk: a replacement render may have published
    // between the checks above and the copy finishing.
    const latestMetadata = (await inspectTrack(slug)).metadata;
    const latestRelative = deliveryRelativePath(slug, presetId, latestMetadata?.deliveryFolder);
    const after = trackExportCoverage(slug).find(
      (entry) => entry.presetId === presetId,
    );
    const identity = statSync(facts.outputPath);

    if (
      latestRelative !== relativePath ||
      resolveDeliveryRoot(resolved).root !== root ||
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

    // Keep ownership fenced until the matching receipt is committed too.
    const delivered = await lock.commitAsync(async () => {
      lock.assertOwned();
      const published = await staged.commit();
      lock.assertOwned();
      const receipt: DeliveryReceipt = {
        schemaVersion: DELIVERY_RECEIPT_VERSION,
        slug, presetId, sourceFingerprint: before.fingerprint!,
        sourceOutput: before.identity,
        destinationRoot: root, destinationRelativePath: relativePath,
        deliveredAt: new Date().toISOString(), bytes: published.size,
        mtimeMs: published.mtimeMs,
      };
      await writeDeliveryReceipt(receipt, lock.assertOwned);
      return { published, receipt };
    });

    // Only now, with the copy published and its receipt committed, is there a
    // delivery to record. The snapshot is the metadata this delivery actually
    // used, so later edits never reach back into what history says.
    const snapshot = latestMetadata ?? metadata;
    const recorded = snapshot === null
      ? {
          eventId: null,
          problem:
            `${facts.outputLabel} was delivered, but the track's metadata could not be read, so it was not recorded in the delivery log.`,
        }
      : await recordDelivery({ root, receipt: delivered.receipt, metadata: snapshot });

    return outcome(slug, presetId, label, {
      ...common,
      status: "delivered",
      bytes: delivered.published.size,
      historyEventId: recorded.eventId,
      historyProblem: recorded.problem,
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
    await staged.close();
  }
};

/**
 * Shared by manual and automatic delivery.
 *
 * Takes the target lock for the whole delivery, so a copy can never be taken
 * from an export that a render is replacing underneath it, and two deliveries
 * of the same target cannot interleave. Holding it across the copy rather than
 * only across the commit is deliberate: the copy is bounded, the lock is
 * per-target so unrelated work is unaffected, and it removes the entire class
 * of "the source moved while we were reading it" races rather than detecting
 * them after the fact.
 *
 * Never turns a copy failure into a failed render. Invalid request identifiers
 * still throw, because those are request errors rather than states of the
 * world.
 */
export const deliverExport = async (input: DeliverExportInput): Promise<DeliveryOutcome> => {
  const slug = assertValidSlug(input.slug);
  const presetId = assertRenderPresetId(input.presetId);
  const label = RENDER_PRESETS[presetId].shortLabel;

  // Nothing to own when there is nowhere to deliver to: this must not create a
  // lock file, and must not be refusable because a render happens to be running.
  const settings = input.settings ?? (await readDeliverySettings());
  const { root, problem } = resolveDeliveryRoot(settings);
  if (root === null) {
    return outcome(slug, presetId, label, {
      status: problem === null ? "not_configured" : "failed",
      reason: problem === null ? "not_configured" : "copy_failed",
      message:
        problem ??
        "No export destination is configured, so there is nowhere to deliver to.",
    });
  }

  try {
    return await withRenderTargetLock(slug, presetId, (lock) =>
      deliverOwnedExport({ ...input, settings }, lock),
    );
  } catch (error) {
    const busy =
      error instanceof TrackError && error.code === "RENDER_TARGET_LOCKED";
    return outcome(slug, presetId, label, {
      reason: "copy_failed",
      message: busy
        ? `${slug} / ${presetId} is being rendered or delivered right now, so it was not copied. Try again once that finishes.`
        : error instanceof Error
          ? error.message
          : String(error),
    });
  }
};

/** Current delivery state for one target, without delivering anything. */
export const deliveryStateForTarget = (
  slug: string,
  presetId: RenderPresetId,
  facts: Parameters<typeof deliveryStateFor>[0],
  root: string | null,
  deliveryFolder: string | null | undefined,
) => {
  if (root === null) return deliveryStateFor(facts, null, null, "");
  return deliveryStateFor(
    facts,
    readDeliveryReceipt(slug, presetId),
    root,
    deliveryRelativePath(slug, presetId, deliveryFolder),
  );
};
