import type { RendererId } from "../domain/video/renderers.ts";
import type { VisualizerProps } from "../domain/video/visualizerProps.ts";

/**
 * The renderer extension point.
 *
 * The engine (services/render/renderTrackVideo.ts) owns everything around a
 * render: the per-target lock, input fingerprinting, staged publication, the
 * content-library record and auto-delivery. A RenderEngine owns only the part
 * that turns VisualizerProps into a video file. Remotion is one implementation
 * (adapters/remotion/remotionRenderEngine.mts); another renderer — a Premiere
 * Pro or After Effects bridge, a cloud farm — implements this interface and
 * gets all of the above for free.
 *
 * Pure types plus one tiny helper, so any host can implement it.
 */

/**
 * Registers a callback to run when the caller cancels.
 *
 * Structurally identical to Remotion's CancelSignal, so the Remotion adapter
 * hands it straight to renderMedia(); other adapters subscribe to it the same
 * way.
 */
export type CancelSignal = (onCancel: () => void) => void;

/**
 * A signal plus the function that fires it. Callbacks registered after
 * cancel() run immediately; cancel() is idempotent.
 */
export const makeCancelSignal = (): {
  readonly cancelSignal: CancelSignal;
  readonly cancel: () => void;
} => {
  const callbacks: (() => void)[] = [];
  let cancelled = false;

  return {
    cancelSignal: (onCancel) => {
      callbacks.push(onCancel);
      if (cancelled) {
        onCancel();
      }
    },
    cancel: () => {
      if (cancelled) {
        return;
      }
      callbacks.forEach((onCancel) => {
        onCancel();
      });
      cancelled = true;
    },
  };
};

export type RenderProgressUpdate = {
  /** 0–1 */
  readonly progress: number;
  readonly renderedFrames: number;
  readonly encodedFrames: number;
  /** Engine-specific label for the current stage; informational only. */
  readonly stitchStage: string;
};

/** What a session reports once it knows the video it is about to produce. */
export type ResolvedVideo = {
  readonly durationInFrames: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
};

export type RenderEngine = {
  /**
   * Which renderer this is (core/domain/video/renderers.ts). Recorded with
   * every export it produces, and part of the export's freshness fingerprint.
   */
  readonly id: RendererId;
  /**
   * Gets ready to render (bundling, launching an app, connecting to a host).
   * The returned session must always be closed, success or not.
   */
  readonly open: () => Promise<RenderSession>;
};

export type RenderSession = {
  /**
   * Absolute directory the session reads VisualizerProps' public/-relative
   * *Src assets from. The engine fingerprints these exact files, so an export's
   * manifest describes what the renderer consumed rather than live sources that
   * may change mid-render. An engine that reads public/ in place returns it.
   */
  readonly assetRoot: string;
  /** Determines duration and canvas for these props. Called once, first. */
  readonly resolve: (props: VisualizerProps) => Promise<ResolvedVideo>;
  /**
   * Renders the resolved video to outputPath (a staging path the engine
   * publishes afterwards). Rejects if cancelled.
   */
  readonly render: (options: {
    readonly outputPath: string;
    readonly cancelSignal?: CancelSignal;
    readonly onProgress?: (update: RenderProgressUpdate) => void;
  }) => Promise<void>;
  /** Releases everything open() and resolve() acquired. Idempotent. */
  readonly close: () => Promise<void>;
};
