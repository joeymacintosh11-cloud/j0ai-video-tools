import { Audio } from "@remotion/media";
import { getAudioDurationInSeconds } from "@remotion/media-utils";
import {
  AbsoluteFill,
  CalculateMetadataFunction,
  staticFile,
  useVideoConfig,
} from "remotion";
import { secondsToFrames } from "../domain/video/compositionConfig";
import { Background } from "./Background";
import { BrandMark } from "./BrandMark";
import { CoverArt } from "./CoverArt";
import { TrackInfo } from "./TrackInfo";
import { Waveform } from "./Waveform";

export type BeatVisualizerProps = {
  readonly title: string;
  readonly artist: string;
  readonly musicalKey: string;
  readonly bpm: number;
  readonly subtitle?: string;
  /** All *Src fields are paths relative to public/, e.g. "tracks/x/cover.png" */
  readonly coverSrc: string;
  readonly audioSrc: string;
  /** Lightweight audio used for the waveform only; falls back to audioSrc */
  readonly waveformAudioSrc?: string;
  readonly brandLogoSrc: string;
  readonly brandBadgeSrc: string;
};

export const calculateBeatVisualizerMetadata: CalculateMetadataFunction<
  BeatVisualizerProps
> = async ({ props }) => {
  const durationInSeconds = await getAudioDurationInSeconds(
    staticFile(props.audioSrc),
  );

  return {
    durationInFrames: secondsToFrames(durationInSeconds),
  };
};

export const BeatVisualizer: React.FC<BeatVisualizerProps> = ({
  title,
  artist,
  musicalKey,
  bpm,
  subtitle,
  coverSrc,
  audioSrc,
  waveformAudioSrc,
  brandLogoSrc,
  brandBadgeSrc,
}) => {
  const { width } = useVideoConfig();
  const sidePadding = 120;

  const resolvedAudioSrc = staticFile(audioSrc);
  const resolvedWaveformSrc = staticFile(waveformAudioSrc ?? audioSrc);

  return (
    <AbsoluteFill>
      <Background />
      <Audio src={resolvedAudioSrc} />
      <AbsoluteFill
        style={{
          flexDirection: "column",
          rowGap: 40,
          padding: `90px ${sidePadding}px`,
        }}
      >
        <BrandMark src={staticFile(brandLogoSrc)} height={112} />

        <div
          style={{
            flex: 1,
            display: "flex",
            flexDirection: "row",
            alignItems: "center",
            gap: 96,
          }}
        >
          <CoverArt
            coverSrc={staticFile(coverSrc)}
            badgeSrc={staticFile(brandBadgeSrc)}
            size={520}
          />
          <TrackInfo
            title={title}
            artist={artist}
            musicalKey={musicalKey}
            bpm={bpm}
            subtitle={subtitle}
          />
        </div>

        <div style={{ marginTop: 20 }}>
          <Waveform
            src={resolvedWaveformSrc}
            width={width - sidePadding * 2}
            height={130}
          />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
