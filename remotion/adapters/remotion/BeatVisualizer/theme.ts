import { loadFont as loadBebasNeue } from "@remotion/google-fonts/BebasNeue";
import { loadFont as loadOswald } from "@remotion/google-fonts/Oswald";

export const COLORS = {
  offBlack: "#0b0b0b",
  warmCream: "#f4e8d0",
  vintageGold: "#b8860b",
  deepRed: "#7a1e1e",
  oliveGreen: "#2d3a2e",
} as const;

const { fontFamily: headlineFontFamily } = loadBebasNeue();
const { fontFamily: labelFontFamily } = loadOswald("normal", {
  weights: ["400", "600"],
  subsets: ["latin"],
});

export const FONTS = {
  headline: headlineFontFamily,
  label: labelFontFamily,
} as const;
