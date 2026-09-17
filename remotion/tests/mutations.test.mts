import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { uploadTrackAsset } from "../services/tracks/uploadTrackAsset.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { fixture, tempFiles } from "./fixtures.mts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

test("concurrent uploads publish one complete payload, never mixed bytes", async (t) => {
  const f = await fixture(t);
  const a = Buffer.concat([png, Buffer.alloc(100000, 65)]);
  const b = Buffer.concat([png, Buffer.alloc(50000, 66)]);
  async function* body(data: Buffer) {
    yield data.subarray(0, 20000);
    await delay(20);
    yield data.subarray(20000);
  }
  const results = await Promise.allSettled([
    uploadTrackAsset({ slug: f.slug, kind: "cover", body: body(a) }),
    uploadTrackAsset({ slug: f.slug, kind: "cover", body: body(b) }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "fulfilled"],
  );
  const saved = await readFile(f.cover);
  assert.ok(saved.equals(a) || saved.equals(b));
  assert.deepEqual(await tempFiles(f.trackDir), []);
});

test("concurrent metadata patches preserve both independent edits", async (t) => {
  const f = await fixture(t);
  const results = await Promise.allSettled([
    updateTrackMetadata(f.slug, { title: "Changed" }),
    updateTrackMetadata(f.slug, { bpm: 120 }),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "fulfilled"],
  );
  const metadata = JSON.parse(await readFile(f.metadata, "utf8"));
  assert.equal(metadata.title, "Changed");
  assert.equal(metadata.bpm, 120);
  assert.deepEqual(await tempFiles(f.trackDir), []);
});
