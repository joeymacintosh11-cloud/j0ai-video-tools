import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import {
  publicLabel,
  trackAssetPaths,
} from "../../src/domain/tracks/paths.ts";
import { trackLocations } from "./trackLocations.ts";

const execFileAsync = promisify(execFile);

// Mono/16-bit/22.05kHz is more than enough resolution for a bar-spectrum
// visualizer and decodes far faster in the browser than the original
// 24-bit stereo master.
const ANALYSIS_CHANNELS = "1";
const ANALYSIS_SAMPLE_RATE = "22050";

export type AnalysisAudioResult = {
  /** Path relative to public/, e.g. "tracks/<slug>/analysis.wav" */
  readonly relativePath: string;
  readonly absolutePath: string;
  readonly regenerated: boolean;
};

/**
 * Ensures public/tracks/<slug>/analysis.wav exists and is at least as new as
 * beat.wav, (re)generating it with ffmpeg when it's missing or stale.
 *
 * beat.wav itself is never modified — it stays the source for final render
 * audio; analysis.wav is only ever used for waveform analysis.
 */
export const ensureAnalysisAudio = async (
  slug: string,
): Promise<AnalysisAudioResult> => {
  const locations = trackLocations(slug);
  const relativePath = trackAssetPaths(slug).analysis;

  if (!existsSync(locations.beat)) {
    const beatLabel = publicLabel(trackAssetPaths(slug).beat);
    throw new TrackError(
      trackIssue(
        "AUDIO_MISSING",
        `Track "${slug}" is missing audio: ${beatLabel}`,
        beatLabel,
      ),
    );
  }

  const result = (regenerated: boolean): AnalysisAudioResult => ({
    relativePath,
    absolutePath: locations.analysis,
    regenerated,
  });

  const beatMtimeMs = statSync(locations.beat).mtimeMs;
  const analysisExists = existsSync(locations.analysis);

  if (analysisExists && statSync(locations.analysis).mtimeMs >= beatMtimeMs) {
    return result(false);
  }

  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-i",
      locations.beat,
      "-vn",
      "-ac",
      ANALYSIS_CHANNELS,
      "-ar",
      ANALYSIS_SAMPLE_RATE,
      "-c:a",
      "pcm_s16le",
      locations.analysis,
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    if (reason.includes("ENOENT")) {
      throw new TrackError(
        trackIssue(
          "FFMPEG_NOT_FOUND",
          "ffmpeg was not found on PATH. Install ffmpeg to generate the waveform " +
            "analysis audio (https://ffmpeg.org/download.html).",
        ),
      );
    }

    throw new TrackError(
      trackIssue(
        "ANALYSIS_GENERATION_FAILED",
        `Failed to generate ${publicLabel(relativePath)} with ffmpeg: ${reason}`,
        publicLabel(relativePath),
      ),
    );
  }

  return result(true);
};
