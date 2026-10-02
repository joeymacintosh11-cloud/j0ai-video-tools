import assert from "node:assert/strict";
import test from "node:test";
import { remotionRenderEngine } from "../adapters/remotion/remotionRenderEngine.mts";
import { renderEngines } from "../adapters/renderEngines.mts";
import { TrackError } from "../core/domain/tracks/errors.ts";
import {
  assertRendererId,
  DEFAULT_RENDERER_ID,
  RENDERER_IDS,
  storedRendererId,
} from "../core/domain/video/renderers.ts";
import type { RenderEngine } from "../core/ports/renderEngine.ts";
import { createRenderEngineRegistry } from "../core/ports/renderEngineRegistry.ts";

/**
 * Renderer ids (core/domain/video/renderers.ts) and the engine registry
 * (core/ports/renderEngineRegistry.ts, adapters/renderEngines.mts): callers
 * ask for an engine by id and get it, or a clear error.
 */

const stubEngine = (id: RenderEngine["id"]): RenderEngine => ({
  id,
  open: async () => {
    throw new Error("not used");
  },
});

const isTrackError = (code: string, pattern: RegExp) => (error: unknown) =>
  error instanceof TrackError && error.code === code && pattern.test(error.message);

test("the default renderer is Remotion, and the reserved ids are known", () => {
  assert.equal(DEFAULT_RENDERER_ID, "remotion");
  assert.deepEqual(RENDERER_IDS, ["remotion", "premiere", "after-effects"]);
  for (const absent of [undefined, null, ""]) {
    assert.equal(assertRendererId(absent), "remotion");
  }
  assert.equal(assertRendererId("after-effects"), "after-effects");
});

test("an unknown renderer id is a clear INVALID_RENDERER error naming the valid ids", () => {
  for (const bad of ["blender", "Remotion", 42, {}]) {
    assert.throws(
      () => assertRendererId(bad),
      isTrackError("INVALID_RENDERER", /Unknown render engine .*remotion, premiere, after-effects/),
    );
  }
});

test("a stored renderer id reads back leniently: missing means Remotion, garbage means unknown", () => {
  assert.equal(storedRendererId(undefined), "remotion");
  assert.equal(storedRendererId("premiere"), "premiere");
  assert.equal(storedRendererId("blender"), null);
  assert.equal(storedRendererId(null), null);
});

test("this installation's registry resolves the default and an explicit 'remotion' to the Remotion engine", async () => {
  assert.deepEqual(renderEngines.available, ["remotion"]);
  assert.equal(await renderEngines.resolve(undefined), remotionRenderEngine);
  assert.equal(await renderEngines.resolve("remotion"), remotionRenderEngine);
  assert.equal(renderEngines.assertAvailable(undefined), "remotion");
});

test("a known renderer with no adapter is RENDERER_UNAVAILABLE, an unknown one INVALID_RENDERER", async () => {
  await assert.rejects(
    renderEngines.resolve("premiere"),
    isTrackError("RENDERER_UNAVAILABLE", /"premiere" render engine is not available.*Available: remotion/),
  );
  assert.throws(
    () => renderEngines.assertAvailable("after-effects"),
    isTrackError("RENDERER_UNAVAILABLE", /after-effects/),
  );
  await assert.rejects(renderEngines.resolve("blender"), isTrackError("INVALID_RENDERER", /blender/));
});

test("checking availability never loads an engine; resolving loads only the one asked for", async () => {
  const loaded: string[] = [];
  const registry = createRenderEngineRegistry({
    remotion: async () => {
      loaded.push("remotion");
      return stubEngine("remotion");
    },
    premiere: async () => {
      loaded.push("premiere");
      return stubEngine("premiere");
    },
  });

  assert.deepEqual(registry.available, ["remotion", "premiere"]);
  assert.equal(registry.assertAvailable("premiere"), "premiere");
  assert.deepEqual(loaded, []);

  assert.equal((await registry.resolve("premiere")).id, "premiere");
  assert.deepEqual(loaded, ["premiere"]);
});

test("an engine registered under the wrong id is refused", async () => {
  const registry = createRenderEngineRegistry({ premiere: async () => stubEngine("remotion") });
  await assert.rejects(registry.resolve("premiere"), /registered as "premiere" reports id "remotion"/);
});
