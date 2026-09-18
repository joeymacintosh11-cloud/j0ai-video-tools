import { LAYOUTS, titleFontSize, type InfoLayout } from "./layouts";
import { COLORS, FONTS } from "./theme";

type Props = {
  readonly title: string;
  readonly artist: string;
  readonly musicalKey: string;
  readonly bpm: number;
  readonly subtitle?: string;
  /**
   * Sizing for the current format. Defaults to the landscape values, which are
   * the numbers this component has always used, so 16:9 is unaffected.
   */
  readonly layout?: InfoLayout;
};

const Stat: React.FC<{
  label: string;
  value: string;
  labelFontSize: number;
  valueFontSize: number;
  align: "left" | "center";
}> = ({ label, value, labelFontSize, valueFontSize, align }) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: 10,
      paddingLeft: 20,
      borderLeft: `3px solid ${COLORS.vintageGold}`,
      alignItems: align === "center" ? "flex-start" : undefined,
      textAlign: "left",
    }}
  >
    <span
      style={{
        fontFamily: FONTS.label,
        fontSize: labelFontSize,
        fontWeight: 600,
        letterSpacing: 5,
        color: `${COLORS.vintageGold}cc`,
        textTransform: "uppercase",
      }}
    >
      {label}
    </span>
    <span
      style={{
        fontFamily: FONTS.label,
        fontSize: valueFontSize,
        fontWeight: 600,
        letterSpacing: 1,
        color: COLORS.warmCream,
        textTransform: "uppercase",
      }}
    >
      {value}
    </span>
  </div>
);

export const TrackInfo: React.FC<Props> = ({
  title,
  artist,
  musicalKey,
  bpm,
  subtitle,
  layout = LAYOUTS.landscape.info,
}) => {
  const centred = layout.align === "center";
  // Steps down only once a title is long enough to overflow its canvas.
  const titleSize = titleFontSize(layout, title);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: centred ? "center" : undefined,
        textAlign: centred ? "center" : undefined,
      }}
    >
      <span
        style={{
          fontFamily: FONTS.label,
          fontSize: layout.artistFontSize,
          fontWeight: 600,
          letterSpacing: 8,
          color: COLORS.deepRed,
          textTransform: "uppercase",
        }}
      >
        {artist}
      </span>

      <h1
        style={{
          margin: 0,
          marginTop: layout.titleMarginTop,
          maxWidth: layout.titleMaxWidth,
          fontFamily: FONTS.headline,
          fontSize: titleSize,
          lineHeight: 0.9,
          color: COLORS.warmCream,
          textTransform: "uppercase",
          letterSpacing: 0,
          textShadow: "0 12px 40px rgba(0, 0, 0, 0.45)",
        }}
      >
        {title}
      </h1>

      {subtitle ? (
        <span
          style={{
            marginTop: 18,
            maxWidth: layout.subtitleMaxWidth,
            fontFamily: FONTS.label,
            fontSize: layout.subtitleFontSize,
            fontWeight: 600,
            letterSpacing: 3,
            color: `${COLORS.vintageGold}cc`,
            textTransform: "uppercase",
          }}
        >
          {subtitle}
        </span>
      ) : null}

      <div
        style={{
          display: "flex",
          gap: layout.statGap,
          marginTop: subtitle ? 40 : 56,
        }}
      >
        <Stat
          label="Key"
          value={musicalKey}
          labelFontSize={layout.statLabelFontSize}
          valueFontSize={layout.statValueFontSize}
          align={layout.align}
        />
        <Stat
          label="BPM"
          value={String(bpm)}
          labelFontSize={layout.statLabelFontSize}
          valueFontSize={layout.statValueFontSize}
          align={layout.align}
        />
      </div>
    </div>
  );
};
