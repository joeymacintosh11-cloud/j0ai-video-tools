import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  legacyOutputLabel,
  manifestLabel,
  outputLabel,
  outputRelativePath,
} from "../core/domain/tracks/paths.ts";
import {
  assertRenderPresetId,
  DEFAULT_RENDER_PRESET_ID,
  isRenderPresetId,
  RENDER_PRESET_IDS,
  RENDER_PRESET_LIST,
  RENDER_PRESETS,
  renderPreset,
} from "../core/domain/video/renderPresets.ts";
import { LAYOUTS } from "../adapters/remotion/BeatVisualizer/layouts.ts";
import { COMPOSITION_CONFIG, secondsToFrames } from "../core/domain/video/compositionConfig.ts";
import { trackOutputLocation } from "../services/tracks/trackLocations.ts";

test("every preset is internally consistent", () => {
  for (const preset of RENDER_PRESET_LIST) {
    assert.equal(preset.id, RENDER_PRESETS[preset.id].id, `${preset.id} id matches its key`);
    assert.ok(preset.width > 0 && preset.height > 0, `${preset.id} has real dimensions`);
    assert.ok(preset.fps > 0, `${preset.id} has a frame rate`);
    assert.ok(preset.label.length > 0 && preset.shortLabel.length > 0);
    // Every shape a preset claims must have layout numbers behind it.
    assert.ok(LAYOUTS[preset.layout], `${preset.id} layout ${preset.layout} exists`);
  }
});

test("the three initial formats have the expected canvases", () => {
  assert.deepEqual(
    RENDER_PRESET_LIST.map((p) => [p.id, p.width, p.height, p.fps, p.aspectRatio]),
    [
      ["youtube-16x9", 1920, 1080, 30, "16:9"],
      ["vertical-9x16", 1080, 1920, 30, "9:16"],
      ["square-1x1", 1080, 1080, 30, "1:1"],
    ],
  );
});

test("the default preset is 16:9 and drives the composition config", () => {
  assert.equal(DEFAULT_RENDER_PRESET_ID, "youtube-16x9");

  // compositionConfig must not drift from the preset it claims to describe.
  const preset = renderPreset(DEFAULT_RENDER_PRESET_ID);
  assert.equal(COMPOSITION_CONFIG.width, preset.width);
  assert.equal(COMPOSITION_CONFIG.height, preset.height);
  assert.equal(COMPOSITION_CONFIG.fps, preset.fps);
});

test("preset ids are recognised, and anything else is not", () => {
  for (const id of RENDER_PRESET_IDS) {
    assert.equal(isRenderPresetId(id), true);
  }
  for (const value of ["", "16x9", "youtube", "YOUTUBE-16X9", 1, null, undefined, {}]) {
    assert.equal(isRenderPresetId(value), false);
  }
});

test("an absent preset resolves to the default, so older callers are unchanged", () => {
  for (const absent of [undefined, null, ""]) {
    assert.equal(assertRenderPresetId(absent), DEFAULT_RENDER_PRESET_ID);
  }
});

test("an unknown preset is rejected with INVALID_PRESET and names the options", () => {
  for (const bad of ["tiktok", "1080p", 42, {}]) {
    assert.throws(() => assertRenderPresetId(bad), (error: unknown) => {
      const issue = error as { code: string; message: string };
      assert.equal(issue.code, "INVALID_PRESET");
      // The message has to be actionable on its own.
      for (const id of RENDER_PRESET_IDS) {
        assert.ok(issue.message.includes(id), `message lists ${id}`);
      }
      return true;
    });
  }
});

test("output paths are one folder per track and one file per format", () => {
  assert.equal(outputRelativePath("ghetto-geek", "vertical-9x16"), "ghetto-geek/vertical-9x16.mp4");
  assert.equal(outputLabel("ghetto-geek", "square-1x1"), "out/ghetto-geek/square-1x1.mp4");

  // Distinct per format, so one format can never overwrite another.
  const paths = new Set(
    RENDER_PRESET_IDS.map((id) => trackOutputLocation("ghetto-geek", id).path),
  );
  assert.equal(paths.size, RENDER_PRESET_IDS.length);

  for (const id of RENDER_PRESET_IDS) {
    const location = trackOutputLocation("ghetto-geek", id);
    assert.ok(location.path.endsWith(`/out/ghetto-geek/${id}.mp4`));
    assert.ok(location.dir.endsWith("/out/ghetto-geek"));
    assert.equal(location.label, `out/ghetto-geek/${id}.mp4`);
  }
});

test("the pre-preset output path is still expressible, and is not a format path", () => {
  assert.equal(legacyOutputLabel("ghetto-geek"), "out/ghetto-geek.mp4");
  assert.notEqual(
    legacyOutputLabel("ghetto-geek"),
    outputLabel("ghetto-geek", DEFAULT_RENDER_PRESET_ID),
  );
});

test("duration is the same across formats, since they share a frame rate", () => {
  const seconds = 185.143741;
  const frames = RENDER_PRESET_LIST.map((preset) =>
    secondsToFrames(seconds, preset.fps),
  );

  assert.deepEqual(frames, [5555, 5555, 5555]);
  // Called without an fps it must still behave as it always did.
  assert.equal(secondsToFrames(seconds), 5555);
});

test("Remotion exports keep their paths; other engines get their own folder", () => {
  for (const renderer of [undefined, "remotion"] as const) {
    assert.equal(outputRelativePath("ghetto-geek", "square-1x1", renderer), "ghetto-geek/square-1x1.mp4");
    assert.equal(outputLabel("ghetto-geek", "square-1x1", renderer), "out/ghetto-geek/square-1x1.mp4");
    assert.equal(manifestLabel("ghetto-geek", "square-1x1", renderer), "out/ghetto-geek/square-1x1.manifest.json");
    assert.equal(trackOutputLocation("ghetto-geek", "square-1x1", renderer).dir, trackOutputLocation("ghetto-geek", "square-1x1").dir);
  }
  assert.equal(outputLabel("ghetto-geek", "square-1x1", "after-effects"), "out/ghetto-geek/after-effects/square-1x1.mp4");
  assert.equal(manifestLabel("ghetto-geek", "square-1x1", "after-effects"), "out/ghetto-geek/after-effects/square-1x1.manifest.json");
  const ae = trackOutputLocation("ghetto-geek", "square-1x1", "after-effects");
  assert.ok(ae.path.endsWith(`${path.sep}ghetto-geek${path.sep}after-effects${path.sep}square-1x1.mp4`));
  assert.ok(ae.manifest.endsWith(`${path.sep}after-effects${path.sep}square-1x1.manifest.json`));
});
