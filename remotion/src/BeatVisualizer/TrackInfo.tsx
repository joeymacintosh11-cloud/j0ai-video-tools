import { COLORS, FONTS } from "./theme";

type Props = {
  readonly title: string;
  readonly artist: string;
  readonly musicalKey: string;
  readonly bpm: number;
  readonly subtitle?: string;
};

const Stat: React.FC<{ label: string; value: string }> = ({
  label,
  value,
}) => (
  <div
    style={{
      display: "flex",
      flexDirection: "column",
      gap: 10,
      paddingLeft: 20,
      borderLeft: `3px solid ${COLORS.vintageGold}`,
    }}
  >
    <span
      style={{
        fontFamily: FONTS.label,
        fontSize: 18,
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
        fontSize: 34,
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
}) => {
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <span
        style={{
          fontFamily: FONTS.label,
          fontSize: 26,
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
          marginTop: 20,
          maxWidth: 940,
          fontFamily: FONTS.headline,
          fontSize: 158,
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
            maxWidth: 760,
            fontFamily: FONTS.label,
            fontSize: 22,
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
          gap: 72,
          marginTop: subtitle ? 40 : 56,
        }}
      >
        <Stat label="Key" value={musicalKey} />
        <Stat label="BPM" value={String(bpm)} />
      </div>
    </div>
  );
};
