import {
  RENDER_PRESETS,
  type RenderPresetId,
} from "../../core/domain/video/renderPresets.ts";
import {
  DEFAULT_RENDERER_ID,
  RENDERER_LABELS,
  type RendererId,
} from "../../core/domain/video/renderers.ts";
import { updateReleaseBundleAfterDelivery } from "./autoReleaseBundle.ts";
import { deliverExport, type DeliveryOutcome } from "./deliverExport.ts";
import { readDeliverySettings, type DeliverySettings } from "./deliverySettings.ts";

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
  /**
   * The engine that just rendered. Delivery copies Remotion's export, so after
   * any other engine's render it would ship a different video than the one
   * just made; that is reported as not delivered instead.
   */
  renderer: RendererId = DEFAULT_RENDERER_ID,
  /** Read from delivery.local.json when omitted, as deliverExport does. */
  given?: DeliverySettings,
): Promise<DeliveryOutcome | null> => {
  try {
    const settings = given ?? (await readDeliverySettings());

    if (!settings.autoDeliver || settings.root === null) return null;

    if (renderer !== DEFAULT_RENDERER_ID) {
      const skipped: DeliveryOutcome = {
        slug,
        presetId,
        label: RENDER_PRESETS[presetId].shortLabel,
        status: "failed",
        reason: "renderer_not_supported",
        destinationPath: null,
        destinationRelativePath: null,
        bytes: null,
        message: `Auto-delivery copies ${RENDERER_LABELS[DEFAULT_RENDERER_ID]} exports only, so this ${RENDERER_LABELS[renderer]} export was not delivered.`,
        historyEventId: null,
        historyProblem: null,
      };
      report?.(skipped);
      return skipped;
    }

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
