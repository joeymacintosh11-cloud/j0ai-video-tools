import { Player } from "@remotion/player";
import { useState } from "react";
import { BeatVisualizer } from "../../src/BeatVisualizer/BeatVisualizer.tsx";
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
const PreviewPlayer: React.FC<{ readonly slug: string }> = ({ slug }) => {
  const preview = useAsync(() => getTrackPreview(slug), [slug]);

  if (preview.error) {
    return <ErrorBanner error={preview.error} title="Cannot preview" />;
  }

  if (!preview.data) {
    return <p className="muted">Loading preview…</p>;
  }

  const { composition, durationInFrames, inputProps, analysisAvailable } =
    preview.data;

  return (
    <div className="preview">
      <Player
        component={BeatVisualizer}
        inputProps={inputProps}
        durationInFrames={durationInFrames}
        compositionWidth={composition.width}
        compositionHeight={composition.height}
        fps={composition.fps}
        controls
        acknowledgeRemotionLicense
        style={{ width: "100%" }}
      />
      <p className="preview__note">
        {analysisAvailable
          ? "Waveform reads analysis.wav; audio is the original beat.wav."
          : "analysis.wav has not been generated, so the waveform is reading the full beat.wav — run Prepare to make this faster."}
      </p>
    </div>
  );
};

export const TrackPreview: React.FC<{
  readonly slug: string;
  readonly canPreview: boolean;
}> = ({ slug, canPreview }) => {
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
      <PreviewPlayer slug={slug} />
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
