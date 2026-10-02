import type { RenderLayout } from "../../../core/domain/video/renderPresets.ts";

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
export type TitleSizeStep = {
  /** Longest title, in characters, that still uses this size. */
  readonly maxChars: number;
  readonly fontSize: number;
};

export type InfoLayout = {
  readonly artistFontSize: number;
  /** Size for a title short enough not to need stepping down. */
  readonly titleFontSize: number;
  /**
   * Larger titles wrap onto more lines, and past a point the extra lines push
   * the waveform out of frame entirely — which is what a 45-character title did
   * to the landscape layout. Stepping the size down keeps a long title inside
   * its canvas. The first step is the untouched base size, so every title short
   * enough to have always fitted renders exactly as it did.
   */
  readonly titleSizeSteps: readonly TitleSizeStep[];
  readonly titleMaxWidth: number;
  readonly titleMarginTop: number;
  readonly subtitleFontSize: number;
  readonly subtitleMaxWidth: number;
  readonly statLabelFontSize: number;
  readonly statValueFontSize: number;
  readonly statGap: number;
  readonly align: "left" | "center";
};

/**
 * The size to draw a title at, given how long it is.
 *
 * Short titles keep the layout's base size, so existing output is unaffected.
 */
export const titleFontSize = (layout: InfoLayout, title: string): number => {
  const step = layout.titleSizeSteps.find(
    (candidate) => title.length <= candidate.maxChars,
  );

  return step?.fontSize ?? layout.titleFontSize;
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
      titleSizeSteps: [
        { maxChars: 18, fontSize: 158 },
        { maxChars: 30, fontSize: 116 },
        { maxChars: 46, fontSize: 84 },
        { maxChars: Number.POSITIVE_INFINITY, fontSize: 64 },
      ],
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
      titleSizeSteps: [
        { maxChars: 18, fontSize: 132 },
        { maxChars: 30, fontSize: 104 },
        { maxChars: 46, fontSize: 82 },
        { maxChars: Number.POSITIVE_INFINITY, fontSize: 66 },
      ],
      titleMaxWidth: 860,
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
      titleSizeSteps: [
        { maxChars: 18, fontSize: 84 },
        { maxChars: 30, fontSize: 66 },
        { maxChars: 46, fontSize: 52 },
        { maxChars: Number.POSITIVE_INFINITY, fontSize: 44 },
      ],
      titleMaxWidth: 860,
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
