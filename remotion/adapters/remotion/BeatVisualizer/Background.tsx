import { AbsoluteFill } from "remotion";
import { Grain } from "./Grain";
import { COLORS } from "./theme";

export const Background: React.FC = () => (
  <AbsoluteFill
    style={{
      backgroundColor: COLORS.offBlack,
      backgroundImage: [
        "radial-gradient(ellipse at center, transparent 45%, rgba(0, 0, 0, 0.55) 100%)",
        `radial-gradient(ellipse at 30% 25%, ${COLORS.deepRed}22 0%, transparent 55%)`,
        `radial-gradient(ellipse at 80% 90%, ${COLORS.oliveGreen}22 0%, transparent 55%)`,
      ].join(", "),
    }}
  >
    <Grain />
  </AbsoluteFill>
);
