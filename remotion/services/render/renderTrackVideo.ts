import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderMedia,
  selectComposition,
  type CancelSignal,
} from "@remotion/renderer";
import { existsSync, mkdirSync } from "node:fs";
import type { BeatVisualizerProps } from "../../src/BeatVisualizer/BeatVisualizer.ts";
import { OUTPUT_FILE_NAME } from "../../src/domain/tracks/paths.ts";
import { COMPOSITION_ID } from "../../src/domain/video/compositionConfig.ts";
import {
  OUT_DIR,
  REMOTION_ENTRY_POINT,
  trackLocations,
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
  readonly outputPath: string;
  readonly outputLabel: string;
};

export type RenderTrackVideoOptions = {
  readonly slug: string;
  readonly props: BeatVisualizerProps;
  readonly cancelSignal?: CancelSignal;
  readonly onPhase?: (phase: RenderPhase) => void;
  readonly onResolved?: (info: RenderResolvedInfo) => void;
  readonly onProgress?: (update: RenderProgressUpdate) => void;
};

export type RenderTrackVideoResult = RenderResolvedInfo;

/**
 * Renders a prepared track to out/<slug>.mp4.
 *
 * Shared by the render-track CLI and the API's render worker so there is
 * exactly one place that knows how this project encodes video. The caller
 * supplies props (from prepareTrack) and gets real progress via callbacks —
 * nothing here logs or decides exit codes.
 *
 * Encoding settings are deliberately identical to what the CLI has always
 * used; changing them would change render output.
 */
export const renderTrackVideo = async ({
  slug,
  props,
  cancelSignal,
  onPhase,
  onResolved,
  onProgress,
}: RenderTrackVideoOptions): Promise<RenderTrackVideoResult> => {
  onPhase?.("bundling");
  const bundleLocation = await bundle({ entryPoint: REMOTION_ENTRY_POINT });

  // A single shared browser instance is reused for both steps below, which
  // is more reliable than letting each API launch (and tear down) its own.
  const puppeteerInstance = await openBrowser("chrome");

  try {
    onPhase?.("resolving");
    const composition = await selectComposition({
      serveUrl: bundleLocation,
      id: COMPOSITION_ID,
      inputProps: props,
      puppeteerInstance,
    });

    const outputPath = trackLocations(slug).output;
    const resolved: RenderResolvedInfo = {
      durationInFrames: composition.durationInFrames,
      fps: composition.fps,
      outputPath,
      outputLabel: `out/${OUTPUT_FILE_NAME(slug)}`,
    };
    onResolved?.(resolved);

    if (!existsSync(OUT_DIR)) {
      mkdirSync(OUT_DIR, { recursive: true });
    }

    onPhase?.("rendering");
    await renderMedia({
      composition,
      serveUrl: bundleLocation,
      codec: "h264",
      outputLocation: outputPath,
      inputProps: props,
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
      onProgress: ({ progress, renderedFrames, encodedFrames, stitchStage }) => {
        onProgress?.({ progress, renderedFrames, encodedFrames, stitchStage });
      },
    });

    return resolved;
  } finally {
    await puppeteerInstance.close({ silent: true });
  }
};
