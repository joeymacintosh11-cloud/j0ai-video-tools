import { useWindowedAudioData, visualizeAudio } from "@remotion/media-utils";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS } from "./theme";

type Props = {
  readonly src: string;
  readonly width: number;
  readonly height: number;
};

const NUMBER_OF_BARS = 64;
const MIN_DB = -100;
const MAX_DB = -30;

const scaleForVisualBalance = (value: number) => {
  if (value <= 0) {
    return 0;
  }
  const db = 20 * Math.log10(value);
  const scaled = (db - MIN_DB) / (MAX_DB - MIN_DB);
  return Math.min(1, Math.max(0, scaled));
};

export const Waveform: React.FC<Props> = ({ src, width, height }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  // Small window: visualizeAudio only needs a brief slice of audio around
  // the current frame. Keeping this small avoids re-decoding a large chunk
  // of the beat on every one of the thousands of frames during a render.
  const { audioData, dataOffsetInSeconds } = useWindowedAudioData({
    src,
    frame,
    fps,
    windowInSeconds: 2,
  });

  const frequencies = audioData
    ? visualizeAudio({
        fps,
        frame,
        audioData,
        numberOfSamples: NUMBER_OF_BARS,
        optimizeFor: "speed",
        dataOffsetInSeconds,
      }).map(scaleForVisualBalance)
    : new Array(NUMBER_OF_BARS).fill(0);

  return (
    <div
      style={{
        width,
        height,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {frequencies.map((amplitude, i) => (
        <div
          key={i}
          style={{
            flex: 1,
            maxWidth: 8,
            marginInline: 3,
            minHeight: 3,
            height: Math.max(3, amplitude * height),
            borderRadius: 5,
            opacity: 0.85,
            background: `linear-gradient(180deg, ${COLORS.vintageGold}, ${COLORS.deepRed})`,
          }}
        />
      ))}
    </div>
  );
};
