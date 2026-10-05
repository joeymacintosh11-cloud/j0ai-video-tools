import { writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { RendererId } from "../core/domain/video/renderers.ts";
import type { RenderPresetId } from "../core/domain/video/renderPresets.ts";
import { RENDER_PRESETS } from "../core/domain/video/renderPresets.ts";
import {
  makeCancelSignal,
  type RenderEngine,
} from "../core/ports/renderEngine.ts";
import { currentTemplateIdentity } from "../services/render/templateIdentity.ts";
import { renderTrackVideo } from "../services/render/renderTrackVideo.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { PUBLIC_DIR } from "../services/tracks/trackLocations.ts";
import { Worker } from "./managerHarness.mts";

/** Test-only worker bridge: real queue/publication services, synthetic pixels.
 * No production switch or environment hook enables this renderer. */
export const workflowWorker = (
  args: readonly string[],
  options: { mode?: "success" | "failure"; delayMs?: number } = {},
): Worker => {
  const [slug, preset, jobId, renderer] = args;
  const engineId = (renderer ?? "remotion") as RendererId;
  const presetId = preset as RenderPresetId;
  const worker = new Worker();
  worker.pid = process.pid;
  const { cancelSignal, cancel } = makeCancelSignal();
  let cancelled = false;
  worker.send = () => {
    cancelled = true;
    cancel();
    return true;
  };
  const engine: RenderEngine = {
    id: engineId,
    open: async () => ({
      assetRoot: PUBLIC_DIR,
      resolve: async () => {
        const format = RENDER_PRESETS[presetId];
        const template =
          engineId === "after-effects"
            ? currentTemplateIdentity(engineId, presetId).template
            : null;
        if (engineId === "after-effects" && !template)
          throw new Error("Template unavailable");
        return {
          durationInFrames: 30,
          fps: format.fps,
          width: format.width,
          height: format.height,
          ...(template ? { template } : {}),
        };
      },
      render: async ({ outputPath, onProgress }) => {
        await writeFile(outputPath, "partial synthetic output");
        await delay(options.delayMs ?? 10);
        if (cancelled) throw new Error("Synthetic render cancelled");
        if (options.mode === "failure")
          throw new Error("Synthetic render failed");
        await writeFile(outputPath, `${engineId}:${slug}:${presetId}`);
        onProgress?.({
          progress: 1,
          renderedFrames: 30,
          encodedFrames: 30,
          stitchStage: "done",
        });
      },
      close: async () => {},
    }),
  };
  setImmediate(() => {
    void (async () => {
      try {
        const inspection = await inspectTrack(slug);
        if (!inspection.metadata) throw new Error("Invalid synthetic metadata");
        const props = buildTrackProps({
          slug,
          metadata: inspection.metadata,
          analysisAvailable: true,
        });
        const result = await renderTrackVideo({
          engine,
          slug,
          props,
          presetId,
          jobId,
          cancelSignal,
          onPhase: (phase) => {
            if (phase === "rendering")
              worker.emit("message", { type: "status", status: "rendering" });
          },
          onResolved: (info) =>
            worker.emit("message", { type: "resolved", ...info }),
          onProgress: (update) =>
            worker.emit("message", { type: "progress", ...update }),
        });
        worker.emit("message", { type: "done", ...result });
      } catch (error) {
        worker.emit(
          "message",
          cancelled
            ? { type: "cancelled" }
            : {
                type: "error",
                error: { code: "RENDER_FAILED", message: String(error) },
              },
        );
      } finally {
        worker.emit("exit", 0, null);
        worker.emit("close", 0, null);
      }
    })();
  });
  return worker;
};
