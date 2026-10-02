import { useEffect, useState } from "react";
import type { TrackDetailView } from "../../core/domain/api/views.ts";
import { ApiRequestError, prepareTrack, validateTrack } from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

/**
 * Runs validate and prepare, the same two operations the CLI exposes.
 *
 * Prepare is the step that generates analysis.wav — the lightweight mono copy
 * the waveform reads instead of decoding the original 24-bit master on every
 * frame. It is skipped automatically when the existing copy is newer than
 * beat.wav, so pressing this on an up-to-date track is cheap and says so.
 */
export const PrepareActions: React.FC<{
  readonly track: TrackDetailView;
  readonly onChanged: () => void;
}> = ({ track, onChanged }) => {
  const [busy, setBusy] = useState<"validate" | "prepare" | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);

  useEffect(() => {
    setResult(null);
    setError(null);
  }, [track.slug]);

  const run = async (action: "validate" | "prepare") => {
    setBusy(action);
    setResult(null);
    setError(null);

    try {
      if (action === "validate") {
        const outcome = await validateTrack(track.slug);
        const { errors, warnings } = outcome.validation;

        setResult(
          outcome.validation.ok
            ? `Valid — ready to render${
                warnings.length > 0 ? ` (${warnings.length} warning)` : ""
              }`
            : `${errors.length} problem${errors.length === 1 ? "" : "s"} — see validation below`,
        );
      } else {
        const outcome = await prepareTrack(track.slug);

        setResult(
          outcome.analysis.generated
            ? `Generated ${outcome.analysis.path} in ${outcome.elapsedMs} ms`
            : `${outcome.analysis.path} was already up to date (${outcome.elapsedMs} ms)`,
        );
      }

      onChanged();
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(null);
    }
  };

  // Preparing needs beat.wav to exist at all, since ffmpeg reads it.
  const canPrepare = track.audioPresent;

  return (
    <div className="actions">
      {error ? <ErrorBanner error={error} title="Action failed" /> : null}

      <div className="form__actions">
        <button
          className="button"
          type="button"
          disabled={busy !== null || !canPrepare}
          title={
            canPrepare
              ? "Generate or refresh analysis.wav"
              : "Upload beat.wav first"
          }
          onClick={() => void run("prepare")}
        >
          {busy === "prepare" ? "Preparing…" : "Prepare"}
        </button>
        <button
          className="button button--quiet"
          type="button"
          disabled={busy !== null}
          onClick={() => void run("validate")}
        >
          {busy === "validate" ? "Validating…" : "Validate"}
        </button>
        {result ? <span className="actions__result">{result}</span> : null}
      </div>
    </div>
  );
};
