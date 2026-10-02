import { deliverAfterRender } from "../delivery/autoDeliver.ts";
import type { DeliveryOutcome } from "../delivery/deliverExport.ts";
import type { AppendContentLibraryResult } from "../library/contentLibraryLog.ts";
import { publishRecordedExport, trackSnapshotFromProps } from "../library/recordExport.ts";
import { fingerprintInputs } from "../tracks/exportManifest.ts";
import { withRenderTargetLock, type RenderTargetLock } from "./renderLock.ts";
import type { VisualizerProps } from "../../core/domain/video/visualizerProps.ts";
import { COMPOSITION_ID } from "../../core/domain/video/compositionConfig.ts";
import {
  DEFAULT_RENDER_PRESET_ID,
  type RenderPresetId,
} from "../../core/domain/video/renderPresets.ts";
import type {
  CancelSignal,
  RenderEngine,
  RenderProgressUpdate,
} from "../../core/ports/renderEngine.ts";
import { trackOutputLocation } from "../tracks/trackLocations.ts";

export { COMPOSITION_ID };
export type { RenderProgressUpdate };

export type RenderPhase = "bundling" | "resolving" | "rendering";

export type RenderResolvedInfo = {
  readonly durationInFrames: number;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly outputPath: string;
  readonly outputLabel: string;
};

export type RenderTrackVideoOptions = {
  /**
   * The renderer that turns props into a video (core/ports/renderEngine.ts).
   * Chosen by the caller — the CLI and the render worker pass the Remotion
   * adapter — so this module stays renderer-agnostic.
   */
  readonly engine: RenderEngine;
  readonly slug: string;
  readonly props: VisualizerProps;
  /** Format to render; defaults to 16:9, matching the pre-preset behaviour. */
  readonly presetId?: RenderPresetId;
  readonly cancelSignal?: CancelSignal;
  /** Recorded in the target lock, so contention can name the job holding it. */
  readonly jobId?: string | null;
  readonly onPhase?: (phase: RenderPhase) => void;
  readonly onResolved?: (info: RenderResolvedInfo) => void;
  readonly onProgress?: (update: RenderProgressUpdate) => void;
  /** Called when auto-delivery ran, whatever its result. */
  readonly onDelivery?: (outcome: DeliveryOutcome) => void;
  /**
   * Called once the completed export has been recorded in the content
   * library (services/library/recordExport.ts), or has failed to be — the
   * render itself has succeeded either way.
   */
  readonly onRecorded?: (outcome: AppendContentLibraryResult) => void;
};

export type RenderTrackVideoResult = RenderResolvedInfo;

const renderToTarget = async ({
  engine,
  slug,
  props,
  presetId = DEFAULT_RENDER_PRESET_ID,
  cancelSignal,
  jobId,
  onPhase,
  onResolved,
  onProgress,
}: RenderTrackVideoOptions, lock: RenderTargetLock): Promise<{
  readonly resolved: RenderTrackVideoResult;
  readonly recorded: AppendContentLibraryResult;
}> => {
  let cancelled = false;
  cancelSignal?.(() => {
    cancelled = true;
  });
  const checkCancelled = () => {
    if (cancelled) throw new Error("renderMedia() got cancelled");
  };
  checkCancelled();
  onPhase?.("bundling");
  const session = await engine.open();

  try {
    checkCancelled();
    const inputProps: VisualizerProps = { ...props, presetId };
    // Fingerprint the copied assets the renderer actually consumes, not live
    // source files that can change while this render is running.
    const inputs = fingerprintInputs(inputProps, presetId, session.assetRoot);

    onPhase?.("resolving");
    const video = await session.resolve(inputProps);

    const output = trackOutputLocation(slug, presetId);
    const resolved: RenderResolvedInfo = {
      ...video,
      outputPath: output.path,
      outputLabel: output.label,
    };
    onResolved?.(resolved);

    onPhase?.("rendering");
    // publishExport, plus a content-library record for what it published —
    // written only once the publish has succeeded, still under this lock.
    const recorded = await publishRecordedExport({
      slug,
      presetId,
      inputs,
      track: trackSnapshotFromProps(slug, props),
      jobId: jobId ?? null,
      lock,
      checkCancelled,
      produce: async (stagedVideo) => {
        await session.render({ outputPath: stagedVideo, cancelSignal, onProgress });
      },
    });
    return { resolved, recorded };
  } finally {
    await session.close();
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
 * How the video itself is produced is the engine's business (the Remotion
 * adapter keeps the encoding settings the CLI has always used); everything
 * around it — lock, fingerprint, publish, record, deliver — lives here, once,
 * for every engine.
 *
 * The target lock is taken here rather than at either call site, because this
 * is the one place both the CLI and the render worker pass through: whatever
 * starts a render, exactly one process can be producing and publishing a given
 * slug+preset. It covers bundling too, so a second process fails fast instead
 * of spending seconds on a bundle it will not be allowed to publish. A
 * RENDER_TARGET_LOCKED error reaches the CLI as a non-zero exit and the API as
 * a structured job failure.
 *
 * Auto-delivery, when switched on, runs after the lock is released: the export
 * is published and verified by then, and delivery re-checks the file's identity
 * itself, so there is no reason to hold the target for the duration of a copy.
 */
export const renderTrackVideo = async (
  options: RenderTrackVideoOptions,
): Promise<RenderTrackVideoResult> => {
  const presetId = options.presetId ?? DEFAULT_RENDER_PRESET_ID;

  const { resolved, recorded } = await withRenderTargetLock(
    options.slug,
    presetId,
    (lock) => renderToTarget(options, lock),
    { jobId: options.jobId ?? null },
  );

  options.onRecorded?.(recorded);

  await deliverAfterRender(options.slug, presetId, options.onDelivery);

  return resolved;
};
