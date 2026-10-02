import assert from "node:assert/strict";
import test from "node:test";
import { renderPreset } from "../core/domain/video/renderPresets.ts";
import { buildTemplateData, TEMPLATE_DATA_SCHEMA_VERSION } from "../core/domain/video/templateData.ts";
import type { VisualizerProps } from "../core/domain/video/visualizerProps.ts";

/** The sidecar JSON template-driven renderers read (core/domain/video/templateData.ts). */

const props: VisualizerProps = {
  title: "Ghetto Geek",
  artist: "Toshi",
  musicalKey: "F Minor",
  bpm: 100,
  subtitle: "Boom bap soul",
  coverSrc: "tracks/ghetto-geek/cover.png",
  audioSrc: "tracks/ghetto-geek/beat.wav",
  waveformAudioSrc: "tracks/ghetto-geek/analysis.wav",
  brandLogoSrc: "brand/toshi/toshi-logo-light.png",
  brandBadgeSrc: "brand/toshi/toshi-icon-mark.png",
  presetId: "vertical-9x16",
};

const resolveAsset = (relative: string) => `/abs/public/${relative}`;

test("template data carries the track, resolved assets, the format and the timing", () => {
  const data = buildTemplateData({
    props,
    preset: renderPreset("vertical-9x16"),
    durationInFrames: 4500,
    resolveAsset,
  });

  assert.deepEqual(data, {
    schemaVersion: TEMPLATE_DATA_SCHEMA_VERSION,
    track: { title: "Ghetto Geek", artist: "Toshi", key: "F Minor", bpm: 100, subtitle: "Boom bap soul" },
    assets: {
      cover: "/abs/public/tracks/ghetto-geek/cover.png",
      audio: "/abs/public/tracks/ghetto-geek/beat.wav",
      waveformAudio: "/abs/public/tracks/ghetto-geek/analysis.wav",
      brandLogo: "/abs/public/brand/toshi/toshi-logo-light.png",
      brandBadge: "/abs/public/brand/toshi/toshi-icon-mark.png",
    },
    format: { presetId: "vertical-9x16", width: 1080, height: 1920, fps: 30, aspectRatio: "9:16", layout: "portrait" },
    timing: { fps: 30, durationInFrames: 4500, durationInSeconds: 150 },
  });
  // Plain JSON: survives a round trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(data)), data);
});

test("missing optional fields have explicit fallbacks", () => {
  const data = buildTemplateData({
    props: { ...props, subtitle: undefined, waveformAudioSrc: undefined },
    preset: renderPreset("square-1x1"),
    durationInFrames: 31,
    resolveAsset,
  });
  assert.equal(data.track.subtitle, null);
  assert.equal(data.assets.waveformAudio, data.assets.audio);
  assert.equal(data.format.layout, "square");
});
