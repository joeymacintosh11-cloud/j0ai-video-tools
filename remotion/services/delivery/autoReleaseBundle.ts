import {
  generateReleaseBundle,
  type GenerateReleaseBundleResult,
} from "./releaseBundle.ts";
import { readDeliverySettings, type DeliverySettings } from "./deliverySettings.ts";

/**
 * Rewrites a track's release bundle after something was delivered.
 *
 * Off unless switched on. It runs *after* the delivery has finished and
 * released the target lock — a bundle is a description of what shipped, so it
 * has no business holding a render target while it is written.
 *
 * It never throws and never changes the delivery's result. A bundle that
 * cannot be written leaves the delivered files exactly as they are, so
 * "delivered, bundle not updated" is a real state and is reported as one
 * rather than turning a successful delivery into a failure.
 */
export const updateReleaseBundleAfterDelivery = async (
  slugs: readonly string[],
  settings?: DeliverySettings,
): Promise<readonly GenerateReleaseBundleResult[]> => {
  const results: GenerateReleaseBundleResult[] = [];

  try {
    const resolved = settings ?? (await readDeliverySettings());

    if (!resolved.autoUpdateReleaseBundle || resolved.root === null) return [];

    // Distinct slugs only: delivering three formats of one track is one bundle.
    for (const slug of [...new Set(slugs)]) {
      try {
        results.push(
          await generateReleaseBundle({ slug, settings: resolved }),
        );
      } catch (error) {
        results.push({
          slug,
          generated: false,
          freshness: "outdated",
          relativePath: null,
          bundleId: null,
          delivered: 0,
          outdated: 0,
          missing: 0,
          problem: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } catch {
    // Unreachable for ordinary problems, which come back as results above.
    // Swallowed anyway: nothing here may disturb a finished delivery.
    return results;
  }

  return results;
};
