import { Img, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS } from "./theme";

type Props = {
  readonly coverSrc: string;
  readonly badgeSrc: string;
  readonly size: number;
};

const BREATHE_PERIOD_IN_SECONDS = 9;
const BREATHE_AMOUNT = 0.015;
const PARALLAX_AMOUNT_IN_PX = 4;

export const CoverArt: React.FC<Props> = ({ coverSrc, badgeSrc, size }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const cyclePosition =
    (frame / fps / BREATHE_PERIOD_IN_SECONDS) * Math.PI * 2;
  const scale = 1 + Math.sin(cyclePosition) * BREATHE_AMOUNT;
  const parallaxY = Math.sin(cyclePosition) * PARALLAX_AMOUNT_IN_PX;
  const badgeSize = size * 0.2;

  return (
    <div style={{ width: size, height: size, position: "relative" }}>
      <div
        style={{
          position: "absolute",
          inset: -60,
          borderRadius: "50%",
          background: `radial-gradient(circle, ${COLORS.vintageGold}33 0%, transparent 70%)`,
          filter: "blur(30px)",
        }}
      />
      <div
        style={{
          position: "absolute",
          inset: 0,
          transform: `scale(${scale}) translateY(${parallaxY}px)`,
        }}
      >
        <div
          style={{
            width: "100%",
            height: "100%",
            borderRadius: 28,
            overflow: "hidden",
            border: `2px solid ${COLORS.vintageGold}`,
            backgroundColor: COLORS.offBlack,
            boxShadow: "0 40px 90px rgba(0, 0, 0, 0.55)",
          }}
        >
          <Img
            src={coverSrc}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        </div>
        <div
          style={{
            position: "absolute",
            right: -badgeSize * 0.25,
            bottom: -badgeSize * 0.25,
            width: badgeSize,
            height: badgeSize,
            borderRadius: "50%",
            backgroundColor: COLORS.offBlack,
            border: `2px solid ${COLORS.vintageGold}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            boxShadow: "0 12px 30px rgba(0, 0, 0, 0.5)",
          }}
        >
          <Img
            src={badgeSrc}
            style={{ width: "68%", height: "68%", objectFit: "contain" }}
          />
        </div>
      </div>
    </div>
  );
};
