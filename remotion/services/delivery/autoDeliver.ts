import type { RenderPresetId } from "../../src/domain/video/renderPresets.ts";
import { updateReleaseBundleAfterDelivery } from "./autoReleaseBundle.ts";
import { deliverExport, type DeliveryOutcome } from "./deliverExport.ts";
import { readDeliverySettings } from "./deliverySettings.ts";

/**
 * Copies an export straight after it was rendered, when asked to.
 *
 * Off unless switched on: a tool that silently started copying videos into a
 * synced folder would be a surprise, so this does nothing at all until someone
 * turns it on and sets a destination.
 *
 * It runs after the render's target lock has been released and never throws.
 * The canonical export is already published and verified by the time this is
 * called, so a failed copy is reported and nothing more — "render: current,
 * delivery: failed" is a real state, and a delivery problem must never make a
 * successful render look like a failure.
 */
export const deliverAfterRender = async (
  slug: string,
  presetId: RenderPresetId,
  report?: (outcome: DeliveryOutcome) => void,
): Promise<DeliveryOutcome | null> => {
  try {
    const settings = await readDeliverySettings();

    if (!settings.autoDeliver || settings.root === null) return null;

    const outcome = await deliverExport({ slug, presetId, settings });
    report?.(outcome);

    // After the delivery has released the target lock, and only when asked for.
    if (outcome.status === "delivered") {
      await updateReleaseBundleAfterDelivery([slug], settings);
    }

    return outcome;
  } catch {
    // Unreachable for ordinary delivery problems, which come back as outcomes.
    // Swallowed anyway: nothing here may turn a finished render into an error.
    return null;
  }
};
