import type { RenderLayout } from "../domain/video/renderPresets.ts";

/**
 * Per-shape sizing for the visualizer.
 *
 * The same components draw every format — only these numbers change. The
 * landscape values are exactly what the 16:9 render has always used, so that
 * output stays pixel-identical; the other two are tuned for their own canvas
 * rather than being the landscape design scaled down or cropped.
 */

export type BeatVisualizerLayout = {
  /** Horizontal padding, also the waveform's inset from both edges. */
  readonly sidePadding: number;
  readonly verticalPadding: number;
  readonly logoHeight: number;
  readonly coverSize: number;
  readonly waveformHeight: number;
  /** Gap between the main stacked or side-by-side blocks. */
  readonly blockGap: number;
  readonly info: InfoLayout;
};

/**
 * Type sizes for TrackInfo. The landscape numbers are the component's own
 * defaults, so passing this through changes nothing for 16:9.
 */
export type InfoLayout = {
  readonly artistFontSize: number;
  readonly titleFontSize: number;
  readonly titleMaxWidth: number;
  readonly titleMarginTop: number;
  readonly subtitleFontSize: number;
  readonly subtitleMaxWidth: number;
  readonly statLabelFontSize: number;
  readonly statValueFontSize: number;
  readonly statGap: number;
  readonly align: "left" | "center";
};

export const LAYOUTS: Record<RenderLayout, BeatVisualizerLayout> = {
  // 1920x1080 — cover and copy side by side, waveform beneath.
  landscape: {
    sidePadding: 120,
    verticalPadding: 90,
    logoHeight: 112,
    coverSize: 520,
    waveformHeight: 130,
    blockGap: 96,
    info: {
      artistFontSize: 26,
      titleFontSize: 158,
      titleMaxWidth: 940,
      titleMarginTop: 20,
      subtitleFontSize: 22,
      subtitleMaxWidth: 760,
      statLabelFontSize: 18,
      statValueFontSize: 34,
      statGap: 72,
      align: "left",
    },
  },

  // 1080x1920 — one centred column, sized so the title still reads on a phone.
  portrait: {
    sidePadding: 72,
    verticalPadding: 110,
    logoHeight: 84,
    coverSize: 760,
    waveformHeight: 190,
    blockGap: 64,
    info: {
      artistFontSize: 30,
      titleFontSize: 132,
      titleMaxWidth: 936,
      titleMarginTop: 22,
      subtitleFontSize: 26,
      subtitleMaxWidth: 840,
      statLabelFontSize: 20,
      statValueFontSize: 40,
      statGap: 88,
      align: "center",
    },
  },

  // 1080x1080 — the same column, compressed. Sizes are chosen so the whole
  // stack fits inside 1080 without flex having to shrink anything.
  square: {
    sidePadding: 64,
    verticalPadding: 48,
    logoHeight: 58,
    coverSize: 380,
    waveformHeight: 104,
    blockGap: 26,
    info: {
      artistFontSize: 22,
      titleFontSize: 84,
      titleMaxWidth: 952,
      titleMarginTop: 12,
      subtitleFontSize: 19,
      subtitleMaxWidth: 820,
      statLabelFontSize: 15,
      statValueFontSize: 28,
      statGap: 60,
      align: "center",
    },
  },
};
