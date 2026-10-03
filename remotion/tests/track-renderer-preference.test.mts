import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { handleRequest } from "../server/app.ts";
import {
  coerceMetadataDraft,
  serializeTrackMetadata,
  validateTrackMetadata,
} from "../core/domain/tracks/metadata.ts";
import {
  DEFAULT_RENDERER_ID,
  remotionOnlyProblem,
  resolveTrackRenderer,
} from "../core/domain/video/renderers.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { fixture } from "./fixtures.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

await isolateRenderJournalForThisFile();

/**
 * A track's preferred renderer: stored in metadata.json alongside the rest of
 * its intent, defaulting to Remotion when undeclared, and validated against
 * the shared renderer ids.
 */

const api = async (t: TestContext) => {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};

const VALID = { title: "T", artist: "A", key: "F Minor", bpm: 100 };

/* ------------------------------------------------------------------ *
 * Model and validation
 * ------------------------------------------------------------------ */

test("a track with no renderer declared resolves to Remotion, and its file gains no renderer key", () => {
  const { metadata, issues } = validateTrackMetadata(VALID, "metadata.json");
  assert.deepEqual(issues, []);
  assert.equal(metadata?.renderer, undefined);
  assert.equal(resolveTrackRenderer(metadata?.renderer), "remotion");
  assert.equal(DEFAULT_RENDERER_ID, "remotion");

  // Rewriting an old track never invents a preference.
  const written = JSON.parse(serializeTrackMetadata({ ...VALID, bpm: 100 }));
  assert.equal("renderer" in written, false);
});

test("a known renderer id is accepted and kept, including one not installed here", () => {
  for (const renderer of ["remotion", "after-effects", "premiere"] as const) {
    const { metadata, issues } = validateTrackMetadata({ ...VALID, renderer }, "metadata.json");
    assert.deepEqual(issues, [], renderer);
    assert.equal(metadata?.renderer, renderer);
    assert.equal(resolveTrackRenderer(metadata?.renderer), renderer);
  }
});

test("an unknown or removed renderer id is a validation error, never silently replaced", () => {
  for (const renderer of ["photoshop", "", 42, null, ["remotion"]]) {
    const { metadata, issues } = validateTrackMetadata({ ...VALID, renderer }, "metadata.json");
    assert.equal(metadata, null, JSON.stringify(renderer));
    assert.ok(
      issues.some((issue) => issue.code === "METADATA_INVALID" && /"renderer"/.test(issue.message)),
      JSON.stringify(issues),
    );
  }
});

test("the editor draft drops an unknown renderer rather than guessing one", () => {
  assert.equal(coerceMetadataDraft({ ...VALID, renderer: "photoshop" })?.renderer, undefined);
  assert.equal(coerceMetadataDraft({ ...VALID, renderer: "after-effects" })?.renderer, "after-effects");
  assert.equal(coerceMetadataDraft(VALID)?.renderer, undefined);
});

test("the Remotion-only message names the preference, and Remotion itself is never left out", () => {
  assert.equal(remotionOnlyProblem("remotion", "Delivery"), null);
  const message = remotionOnlyProblem("after-effects", "Delivery");
  assert.match(message ?? "", /prefers After Effects/);
  assert.match(message ?? "", /Delivery works with Remotion exports only/);
});

/* ------------------------------------------------------------------ *
 * Persistence
 * ------------------------------------------------------------------ */

test("a renderer preference is saved to metadata.json and read back, and null clears it", async (t) => {
  const f = await fixture(t);

  await updateTrackMetadata(f.slug, { renderer: "after-effects" });
  assert.equal(JSON.parse(await fs.readFile(f.metadata, "utf8")).renderer, "after-effects");
  assert.equal((await inspectTrack(f.slug)).metadata?.renderer, "after-effects");

  // Saving an unrelated field keeps it — a title edit never resets the engine.
  await updateTrackMetadata(f.slug, { title: "Renamed" });
  assert.equal((await inspectTrack(f.slug)).metadata?.renderer, "after-effects");

  await updateTrackMetadata(f.slug, { renderer: null });
  const cleared = JSON.parse(await fs.readFile(f.metadata, "utf8"));
  assert.equal("renderer" in cleared, false);
  assert.equal(resolveTrackRenderer((await inspectTrack(f.slug)).metadata?.renderer), "remotion");
});

test("PATCH /api/tracks/:slug/metadata persists the preference, and rejects an unknown id without writing", async (t) => {
  const f = await fixture(t);
  const base = await api(t);
  const url = `${base}/api/tracks/${f.slug}`;
  const patch = (body: unknown) =>
    fetch(`${url}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const saved = await patch({ renderer: "after-effects" });
  assert.equal(saved.status, 200);
  const view = (await saved.json()).data;
  assert.equal(view.metadata.renderer, "after-effects");
  assert.equal(view.renderer, "after-effects");

  // Survives a fresh read — the route wrote it, it is not only in the response.
  const reread = (await (await fetch(url)).json()).data;
  assert.equal(reread.renderer, "after-effects");

  const before = await fs.readFile(f.metadata);
  const unknown = await patch({ renderer: "photoshop" });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json()).error.code, "INVALID_RENDERER");
  assert.deepEqual(await fs.readFile(f.metadata), before);

  const cleared = await patch({ renderer: null });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).data.renderer, null);
});

test("an older track's view reports no preference and judges Remotion exports, exactly as before", async (t) => {
  const f = await fixture(t);
  const base = await api(t);
  const view = (await (await fetch(`${base}/api/tracks/${f.slug}`)).json()).data;

  assert.equal(view.renderer, null);
  for (const output of view.exports) {
    assert.match(output.outputLabel, new RegExp(`^out/${f.slug}/[a-z0-9-]+\\.mp4$`));
  }
});
