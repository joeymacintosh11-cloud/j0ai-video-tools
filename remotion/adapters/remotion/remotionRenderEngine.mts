import { bundle } from "@remotion/bundler";
import {
  openBrowser,
  renderMedia,
  selectComposition,
} from "@remotion/renderer";
import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { COMPOSITION_ID } from "../../core/domain/video/compositionConfig.ts";
import type { VisualizerProps } from "../../core/domain/video/visualizerProps.ts";
import type {
  RenderEngine,
  RenderSession,
} from "../../core/ports/renderEngine.ts";

/**
 * The Remotion implementation of the RenderEngine port.
 *
 * Everything that knows how this project drives Remotion lives here: bundling
 * the composition, the shared Chromium instance, and the encoding settings.
 * The settings are deliberately identical to what the CLI has always used;
 * changing them would change render output.
 */

const adapterDir = path.dirname(fileURLToPath(import.meta.url));

/** The Remotion entry point (registerRoot) that bundle() starts from. */
export const REMOTION_ENTRY_POINT = path.join(adapterDir, "index.ts");

type Composition = Awaited<ReturnType<typeof selectComposition>>;

const openSession = async (): Promise<RenderSession> => {
  const bundleLocation = await bundle({ entryPoint: REMOTION_ENTRY_POINT });

  // A single shared browser instance is reused for both resolving and
  // rendering, which is more reliable than letting each API launch (and tear
  // down) its own. Opened on first use; closed as soon as rendering finishes.
  let browser: Awaited<ReturnType<typeof openBrowser>> | null = null;
  let resolved: { composition: Composition; inputProps: VisualizerProps } | null = null;

  const closeBrowser = async () => {
    if (browser) {
      const open = browser;
      browser = null;
      await open.close({ silent: true });
    }
  };

  return {
    // bundle() copies public/ into the bundle; that copy is what Chromium reads.
    assetRoot: path.join(bundleLocation, "public"),

    resolve: async (inputProps) => {
      browser ??= await openBrowser("chrome");
      // The preset travels in the props, so calculateBeatVisualizerMetadata
      // reports this format's width, height and frame count back to us.
      const composition = await selectComposition({
        serveUrl: bundleLocation,
        id: COMPOSITION_ID,
        inputProps,
        puppeteerInstance: browser,
      });
      resolved = { composition, inputProps };

      return {
        durationInFrames: composition.durationInFrames,
        fps: composition.fps,
        width: composition.width,
        height: composition.height,
      };
    },

    render: async ({ outputPath, cancelSignal, onProgress }) => {
      if (!resolved || !browser) {
        throw new Error("RenderSession.render() called before resolve().");
      }

      await renderMedia({
        composition: resolved.composition,
        serveUrl: bundleLocation,
        codec: "h264",
        outputLocation: outputPath,
        inputProps: resolved.inputProps,
        imageFormat: "jpeg",
        overwrite: true,
        puppeteerInstance: browser,
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

      await closeBrowser();
    },

    close: async () => {
      try {
        await closeBrowser();
      } finally {
        await rm(bundleLocation, { recursive: true, force: true });
      }
    },
  };
};

export const remotionRenderEngine: RenderEngine = {
  id: "remotion",
  open: openSession,
};
