import { remotionRenderEngine } from "../adapters/remotion/remotionRenderEngine.ts";
import { makeCancelSignal } from "../core/ports/renderEngine.ts";
import { TrackError } from "../core/domain/tracks/errors.ts";
import { publicLabel } from "../core/domain/tracks/paths.ts";
import { assertRenderPresetId } from "../core/domain/video/renderPresets.ts";
import { renderTrackVideo } from "../services/render/renderTrackVideo.ts";
import { prepareTrack } from "../services/tracks/prepareTrack.ts";
import type { WorkerCommand, WorkerEvent } from "./types.ts";

/**
 * Renders one track in one format, in its own process.
 *
 * Isolating the render means a Chromium hang or crash can't take the API
 * server down with it, and cancellation is a real, bounded operation. The
 * parent talks to this process over the fork() IPC channel; the render itself
 * reuses exactly the same shared services the CLI uses.
 */

const emit = (event: WorkerEvent): void => {
  process.send?.(event);
};

const log = (message: string, level: "info" | "error" = "info"): void => {
  emit({ type: "log", level, message });
};

const slug = process.argv[2];

if (!slug) {
  emit({
    type: "error",
    error: {
      code: "INVALID_REQUEST",
      message: "The render worker was started without a track slug.",
    },
  });
  process.exit(1);
}

// Absent means the default format, so an older caller still works.
const presetId = assertRenderPresetId(process.argv[3]);
// Recorded in the render target lock so contention can name the job. Optional:
// a worker started without one still renders.
const jobId = process.argv[4] ?? null;

const { cancelSignal, cancel } = makeCancelSignal();
let cancelRequested = false;

process.on("message", (message: WorkerCommand) => {
  if (message?.type === "cancel" && !cancelRequested) {
    cancelRequested = true;
    log("Cancellation requested — stopping the render.");
    cancel();
  }
});

const main = async (): Promise<void> => {
  emit({ type: "status", status: "preparing" });
  log(`Preparing track "${slug}" for ${presetId}.`);

  // prepareTrack is per-track, and its analysis step is gated on mtime, so
  // rendering several formats of one track regenerates analysis.wav at most
  // once — the later formats reuse it.
  const { props, analysis, metadata } = await prepareTrack(slug);

  log(
    analysis.regenerated
      ? `Generated waveform analysis audio: ${publicLabel(analysis.relativePath)}`
      : `Waveform analysis audio already up to date: ${publicLabel(analysis.relativePath)}`,
  );
  log(`Metadata valid: ${metadata.title} — ${metadata.key}, ${metadata.bpm} BPM.`);

  let lastLoggedPercentage = -1;

  const result = await renderTrackVideo({
    engine: remotionRenderEngine,
    slug,
    props,
    presetId,
    cancelSignal,
    jobId,
    onRecorded: (outcome) => {
      if (outcome.appended && outcome.record) {
        log(`Recorded in the content library (record ${outcome.record.recordId}).`);
      } else if (!outcome.duplicate) {
        log(
          `Could not record this export in the content library: ${outcome.problem ?? "unknown problem"}. The export itself is fine.`,
          "error",
        );
      }
    },
    onPhase: (phase) => {
      if (phase === "bundling") {
        log("Bundling Remotion project.");
      }
      if (phase === "resolving") {
        log("Resolving composition and reading audio duration.");
      }
      if (phase === "rendering") {
        emit({ type: "status", status: "rendering" });
        log("Render started.");
      }
    },
    onResolved: ({ durationInFrames, fps, width, height, outputPath, outputLabel }) => {
      emit({ type: "resolved", durationInFrames, fps, outputPath, outputLabel });
      const seconds = (durationInFrames / fps).toFixed(1);
      log(
        `Duration resolved: ${durationInFrames} frames @ ${fps}fps (${seconds}s), ${width}x${height}.`,
      );
    },
    onDelivery: (outcome) => {
      log(
        outcome.status === "delivered"
          ? `Delivered to ${outcome.destinationRelativePath}.`
          : `Delivery did not happen: ${outcome.message ?? outcome.status}. The export itself is fine.`,
        outcome.status === "delivered" ? "info" : "error",
      );
    },
    onProgress: (update) => {
      emit({ type: "progress", ...update });

      const percentage = Math.floor(update.progress * 100);
      if (percentage !== lastLoggedPercentage && percentage % 10 === 0) {
        lastLoggedPercentage = percentage;
        log(`Render progress: ${percentage}%.`);
      }
    },
  });

  log(`Rendered ${result.outputLabel}.`);
  emit({
    type: "done",
    outputPath: result.outputPath,
    outputLabel: result.outputLabel,
  });
};

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error: unknown) => {
    if (cancelRequested) {
      emit({ type: "cancelled" });
      process.exit(0);
    }

    if (error instanceof TrackError) {
      emit({ type: "error", error: error.issue });
      process.exit(1);
    }

    const details =
      error instanceof Error ? (error.stack ?? error.message) : String(error);

    emit({
      type: "error",
      error: {
        code: "RENDER_FAILED",
        message:
          error instanceof Error
            ? `Render failed: ${error.message}`
            : "Render failed for an unknown reason.",
        details,
      },
    });
    process.exit(1);
  });
