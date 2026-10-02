import { Audio } from "@remotion/media";
import { getAudioDurationInSeconds } from "@remotion/media-utils";
import {
  AbsoluteFill,
  CalculateMetadataFunction,
  staticFile,
  useVideoConfig,
} from "remotion";
import { secondsToFrames } from "../../core/domain/video/compositionConfig";
import {
  DEFAULT_RENDER_PRESET_ID,
  renderPreset,
  type RenderPresetId,
} from "../../core/domain/video/renderPresets";
import { Background } from "./Background";
import { BrandMark } from "./BrandMark";
import { CoverArt } from "./CoverArt";
import { LAYOUTS, type BeatVisualizerLayout } from "./layouts";
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
  /**
   * Which export format to draw. Absent means the default (16:9), so props
   * written before presets existed still render exactly as they did.
   */
  readonly presetId?: RenderPresetId;
};

/**
 * Resolves duration from the audio and canvas size from the preset.
 *
 * Returning width and height here is what lets one composition cover every
 * format: the renderer asks for the composition with a preset in its props and
 * gets that format's dimensions back, so there is no second registration and no
 * duplicated visualizer.
 */
export const calculateBeatVisualizerMetadata: CalculateMetadataFunction<
  BeatVisualizerProps
> = async ({ props }) => {
  const preset = renderPreset(props.presetId ?? DEFAULT_RENDER_PRESET_ID);
  const durationInSeconds = await getAudioDurationInSeconds(
    staticFile(props.audioSrc),
  );

  return {
    durationInFrames: secondsToFrames(durationInSeconds, preset.fps),
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
  };
};

type ArrangementProps = {
  readonly props: BeatVisualizerProps;
  readonly layout: BeatVisualizerLayout;
  readonly coverSrc: string;
  readonly badgeSrc: string;
  readonly logoSrc: string;
  readonly waveformSrc: string;
  readonly canvasWidth: number;
};

/**
 * 16:9 — cover and copy side by side with the waveform beneath.
 *
 * These values are the ones this composition has always used. Changing them
 * changes the existing YouTube output, which is checked against a reference
 * hash, so they are deliberately left as literals rather than tuned.
 */
const LandscapeArrangement: React.FC<ArrangementProps> = ({
  props,
  layout,
  coverSrc,
  badgeSrc,
  logoSrc,
  waveformSrc,
  canvasWidth,
}) => (
  <AbsoluteFill
    style={{
      flexDirection: "column",
      rowGap: 40,
      padding: `${layout.verticalPadding}px ${layout.sidePadding}px`,
    }}
  >
    <BrandMark src={logoSrc} height={layout.logoHeight} />

    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "row",
        alignItems: "center",
        gap: layout.blockGap,
      }}
    >
      <CoverArt
        coverSrc={coverSrc}
        badgeSrc={badgeSrc}
        size={layout.coverSize}
      />
      <TrackInfo
        title={props.title}
        artist={props.artist}
        musicalKey={props.musicalKey}
        bpm={props.bpm}
        subtitle={props.subtitle}
        layout={layout.info}
      />
    </div>

    <div style={{ marginTop: 20 }}>
      <Waveform
        src={waveformSrc}
        width={canvasWidth - layout.sidePadding * 2}
        height={layout.waveformHeight}
      />
    </div>
  </AbsoluteFill>
);

/**
 * 9:16 and 1:1 — one centred column: logo, cover, copy, waveform.
 *
 * Both portrait shapes read top to bottom, so they share this arrangement and
 * differ only in the numbers from their layout entry. Nothing is cropped or
 * letterboxed from the landscape design.
 */
const StackedArrangement: React.FC<ArrangementProps> = ({
  props,
  layout,
  coverSrc,
  badgeSrc,
  logoSrc,
  waveformSrc,
  canvasWidth,
}) => (
  <AbsoluteFill
    style={{
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      rowGap: layout.blockGap,
      padding: `${layout.verticalPadding}px ${layout.sidePadding}px`,
    }}
  >
    <BrandMark src={logoSrc} height={layout.logoHeight} />

    {/*
      flexShrink: 0 — in a column the cover sits on the main axis, so without
      this a tall stack would squash it and objectFit would then crop the
      artwork. The landscape row is deliberately left alone.
    */}
    <div style={{ flexShrink: 0 }}>
      <CoverArt
        coverSrc={coverSrc}
        badgeSrc={badgeSrc}
        size={layout.coverSize}
      />
    </div>

    <TrackInfo
      title={props.title}
      artist={props.artist}
      musicalKey={props.musicalKey}
      bpm={props.bpm}
      subtitle={props.subtitle}
      layout={layout.info}
    />

    <Waveform
      src={waveformSrc}
      width={canvasWidth - layout.sidePadding * 2}
      height={layout.waveformHeight}
    />
  </AbsoluteFill>
);

export const BeatVisualizer: React.FC<BeatVisualizerProps> = (props) => {
  const { width } = useVideoConfig();
  const preset = renderPreset(props.presetId ?? DEFAULT_RENDER_PRESET_ID);
  const layout = LAYOUTS[preset.layout];

  const resolvedAudioSrc = staticFile(props.audioSrc);
  const resolvedWaveformSrc = staticFile(
    props.waveformAudioSrc ?? props.audioSrc,
  );

  const arrangement = {
    props,
    layout,
    coverSrc: staticFile(props.coverSrc),
    badgeSrc: staticFile(props.brandBadgeSrc),
    logoSrc: staticFile(props.brandLogoSrc),
    waveformSrc: resolvedWaveformSrc,
    canvasWidth: width,
  };

  return (
    <AbsoluteFill>
      <Background />
      <Audio src={resolvedAudioSrc} />
      {preset.layout === "landscape" ? (
        <LandscapeArrangement {...arrangement} />
      ) : (
        <StackedArrangement {...arrangement} />
      )}
    </AbsoluteFill>
  );
};
