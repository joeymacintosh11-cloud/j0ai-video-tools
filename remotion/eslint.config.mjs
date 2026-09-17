import { config } from "@remotion/eslint-config-flat";

export default [
  ...config,
  {
    /**
     * ui/ is an ordinary local web app, not a Remotion composition.
     *
     * Two of Remotion's media rules assume they are linting code that renders
     * inside a video, and misfire here:
     *  - warn-native-media-tag wants <Img> from remotion, whose purpose is to
     *    block a frame until the image has loaded. The UI is not frame-based.
     *  - no-string-assets wants staticFile(), but the UI fetches assets over
     *    HTTP from the dev server and the API, where a plain URL is correct.
     *
     * Every other rule (react-hooks, no-console, the TypeScript set) still
     * applies. src/ keeps the full Remotion rule set.
     */
    files: ["ui/**/*.{ts,tsx}"],
    rules: {
      "@remotion/warn-native-media-tag": "off",
      "@remotion/no-string-assets": "off",
    },
  },
];
