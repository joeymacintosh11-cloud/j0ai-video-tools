import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderMedia,
  selectComposition,
  type CancelSignal,
} from "@remotion/renderer";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fingerprintInputs } from "../tracks/exportManifest.ts";
import { publishExport } from "./publishExport.ts";
import { withRenderTargetLock } from "./renderLock.ts";
import type { BeatVisualizerProps } from "../../src/BeatVisualizer/BeatVisualizer.ts";
import { COMPOSITION_ID } from "../../src/domain/video/compositionConfig.ts";
import {
  DEFAULT_RENDER_PRESET_ID,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import {
  REMOTION_ENTRY_POINT,
  trackOutputLocation,
} from "../tracks/trackLocations.ts";

export { COMPOSITION_ID };

export type RenderPhase = "bundling" | "resolving" | "rendering";

export type RenderProgressUpdate = {
  readonly progress: number;
  readonly renderedFrames: number;
  readonly encodedFrames: number;
  readonly stitchStage: string;
};

export type RenderResolvedInfo = {
  readonly durationInFrames: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly outputPath: string;
  readonly outputLabel: string;
};

export type RenderTrackVideoOptions = {
  readonly slug: string;
  readonly props: BeatVisualizerProps;
  /** Format to render; defaults to 16:9, matching the pre-preset behaviour. */
  readonly presetId?: RenderPresetId;
  readonly cancelSignal?: CancelSignal;
  /** Recorded in the target lock, so contention can name the job holding it. */
  readonly jobId?: string | null;
  readonly onPhase?: (phase: RenderPhase) => void;
  readonly onResolved?: (info: RenderResolvedInfo) => void;
  readonly onProgress?: (update: RenderProgressUpdate) => void;
};

export type RenderTrackVideoResult = RenderResolvedInfo;

const renderToTarget = async ({
  slug,
  props,
  presetId = DEFAULT_RENDER_PRESET_ID,
  cancelSignal,
  onPhase,
  onResolved,
  onProgress,
}: RenderTrackVideoOptions): Promise<RenderTrackVideoResult> => {
  let cancelled = false;
  cancelSignal?.(() => {
    cancelled = true;
  });
  const checkCancelled = () => {
    if (cancelled) throw new Error("renderMedia() got cancelled");
  };
  checkCancelled();
  onPhase?.("bundling");
  const bundleLocation = await bundle({ entryPoint: REMOTION_ENTRY_POINT });

  // A single shared browser instance is reused for both steps below, which
  // is more reliable than letting each API launch (and tear down) its own.
  try {
    checkCancelled();
    const inputProps: BeatVisualizerProps = { ...props, presetId };
    // Fingerprint the copied assets the browser actually consumes, not live
    // source files that can change while this render is running.
    const inputs = fingerprintInputs(
      inputProps,
      presetId,
      path.join(bundleLocation, "public"),
    );
    const puppeteerInstance = await openBrowser("chrome");
    let browserClosed = false;
    const closeBrowser = async () => {
      if (!browserClosed) {
        await puppeteerInstance.close({ silent: true });
        browserClosed = true;
      }
    };
    try {
      // The preset travels in the props, so calculateBeatVisualizerMetadata
      // reports this format's width, height and frame count back to us.
      onPhase?.("resolving");
      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: COMPOSITION_ID,
        inputProps,
        puppeteerInstance,
      });

      const output = trackOutputLocation(slug, presetId);
      const resolved: RenderResolvedInfo = {
        durationInFrames: composition.durationInFrames,
        fps: composition.fps,
        width: composition.width,
        height: composition.height,
        outputPath: output.path,
        outputLabel: output.label,
      };
      onResolved?.(resolved);

      onPhase?.("rendering");
      await publishExport(
        slug,
        presetId,
        inputs,
        async (stagedVideo) => {
          await renderMedia({
            composition,
            serveUrl: bundleLocation,
            codec: "h264",
            outputLocation: stagedVideo,
            inputProps,
            imageFormat: "jpeg",
            overwrite: true,
            puppeteerInstance,
            cancelSignal,
            // Each render worker tab pays a one-time cost to decode the waveform
            // analysis audio the first time it reads it; every frame after that
            // is fast. Keep concurrency modest and the timeout generous so that
            // one-time decode has room to finish instead of tripping the frame
            // timeout, even though analysis.wav makes it much smaller than before.
            concurrency: 3,
            timeoutInMilliseconds: 15 * 60 * 1000,
            onProgress: ({
              progress,
              renderedFrames,
              encodedFrames,
              stitchStage,
            }) => {
              onProgress?.({
                progress,
                renderedFrames,
                encodedFrames,
                stitchStage,
              });
            },
          });

          await closeBrowser();
        },
        checkCancelled,
      );
      return resolved;
    } finally {
      await closeBrowser();
    }
  } finally {
    await rm(bundleLocation, { recursive: true, force: true });
  }
};

/**
 * Renders a prepared track to out/<slug>/<preset>.mp4.
 *
 * Shared by the render-track CLI and the API's render worker so there is
 * exactly one place that knows how this project encodes video. The caller
 * supplies props (from prepareTrack) and gets real progress via callbacks —
 * nothing here logs or decides exit codes.
 *
 * Encoding settings are deliberately identical to what the CLI has always
 * used; changing them would change render output.
 *
 * The target lock is taken here rather than at either call site, because this
 * is the one place both the CLI and the render worker pass through: whatever
 * starts a render, exactly one process can be producing and publishing a given
 * slug+preset. It covers bundling too, so a second process fails fast instead
 * of spending seconds on a bundle it will not be allowed to publish. A
 * RENDER_TARGET_LOCKED error reaches the CLI as a non-zero exit and the API as
 * a structured job failure.
 */
export const renderTrackVideo = async (
  options: RenderTrackVideoOptions,
): Promise<RenderTrackVideoResult> =>
  withRenderTargetLock(
    options.slug,
    options.presetId ?? DEFAULT_RENDER_PRESET_ID,
    () => renderToTarget(options),
    { jobId: options.jobId ?? null },
  );
