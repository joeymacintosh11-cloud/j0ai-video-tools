import { Player } from "@remotion/player";
import { useState } from "react";
import { BeatVisualizer } from "../../src/BeatVisualizer/BeatVisualizer.tsx";
import { secondsToFrames } from "../../src/domain/video/compositionConfig.ts";
import {
  renderPreset,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import { getTrackPreview } from "../api/client.ts";
import { useAsync } from "../hooks/useAsync.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

/**
 * Previews a track using the real composition.
 *
 * The component rendered here is the same BeatVisualizer the renderer uses, fed
 * by GET /api/tracks/:slug/preview — composition size, duration and inputProps
 * all come from the server, so nothing about any particular track is baked in.
 *
 * The player is mounted only once asked for. Mounting it fetches beat.wav and
 * decodes analysis.wav for the waveform, which is worth a few seconds when the
 * user wants a preview but not on every track they click through.
 */
const PreviewPlayer: React.FC<{
  readonly slug: string;
  readonly presetId: RenderPresetId;
}> = ({ slug, presetId }) => {
  const preview = useAsync(() => getTrackPreview(slug), [slug]);

  if (preview.error) {
    return <ErrorBanner error={preview.error} title="Cannot preview" />;
  }

  if (!preview.data) {
    return <p className="muted">Loading preview…</p>;
  }

  const { durationInSeconds, inputProps, analysisAvailable } = preview.data;

  // Dimensions and frame count come from the shared preset definition rather
  // than a second request per format — the same module the renderer uses, so
  // the preview is the format it claims to be.
  const preset = renderPreset(presetId);

  return (
    <div className="preview">
      <Player
        key={preset.id}
        component={BeatVisualizer}
        inputProps={{ ...inputProps, presetId: preset.id }}
        durationInFrames={secondsToFrames(durationInSeconds, preset.fps)}
        compositionWidth={preset.width}
        compositionHeight={preset.height}
        fps={preset.fps}
        controls
        acknowledgeRemotionLicense
        style={{ width: "100%" }}
      />
      <p className="preview__note">
        {preset.label} · {preset.width}×{preset.height} —{" "}
        {analysisAvailable
          ? "Waveform reads analysis.wav; audio is the original beat.wav."
          : "analysis.wav has not been generated, so the waveform is reading the full beat.wav — run Prepare to make this faster."}
      </p>
    </div>
  );
};

export const TrackPreview: React.FC<{
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly canPreview: boolean;
}> = ({ slug, presetId, canPreview }) => {
  const [open, setOpen] = useState(false);

  if (!canPreview) {
    return (
      <p className="muted">
        Add cover art, audio and valid metadata to preview this track.
      </p>
    );
  }

  if (!open) {
    return (
      <button className="button" type="button" onClick={() => setOpen(true)}>
        Load preview
      </button>
    );
  }

  return (
    <div className="actions">
      <PreviewPlayer slug={slug} presetId={presetId} />
      <div className="form__actions">
        <button
          className="button button--quiet"
          type="button"
          onClick={() => setOpen(false)}
        >
          Close preview
        </button>
        <span className="muted">
          Decoding the audio takes a moment before playback is smooth.
        </span>
      </div>
    </div>
  );
};
