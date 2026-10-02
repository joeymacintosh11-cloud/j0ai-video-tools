import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";

const execFileAsync = promisify(execFile);

/**
 * Reads an audio file's duration with ffprobe.
 *
 * The render path gets duration from the composition's calculateMetadata (in
 * the browser, from beat.wav) and that stays untouched. This exists so the API
 * can report durationInFrames instantly for a future Player preview, without
 * spinning up a browser or decoding audio.
 */
export const probeAudioDurationInSeconds = async (
  absolutePath: string,
): Promise<number> => {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      absolutePath,
    ]);

    const duration = Number.parseFloat(stdout.trim());

    if (!Number.isFinite(duration) || duration <= 0) {
      throw new Error(`ffprobe returned an unusable duration: "${stdout.trim()}"`);
    }

    return duration;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);

    if (reason.includes("ENOENT")) {
      throw new TrackError(
        trackIssue(
          "FFMPEG_NOT_FOUND",
          "ffprobe was not found on PATH. Install ffmpeg (which includes ffprobe) " +
            "to read audio duration (https://ffmpeg.org/download.html).",
        ),
      );
    }

    throw new TrackError(
      trackIssue(
        "ANALYSIS_GENERATION_FAILED",
        `Could not read audio duration with ffprobe: ${reason}`,
        absolutePath,
      ),
    );
  }
};
