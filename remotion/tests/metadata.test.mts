import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { writeAtomicFile } from "../services/tracks/atomicFile.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { fixture, tempFiles } from "./fixtures.mts";

test("two patches using the same revision cannot overwrite each other", async (t) => {
  const f = await fixture(t);
  const revision = (await inspectTrack(f.slug)).metadataRevision!;
  const results = await Promise.allSettled([
    updateTrackMetadata(f.slug, { title: "First" }, revision),
    updateTrackMetadata(f.slug, { title: "Second" }, revision),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const failed = results.find((r) => r.status === "rejected");
  assert.equal(
    failed?.status === "rejected" && failed.reason.code,
    "METADATA_CONFLICT",
  );
  assert.notEqual((await inspectTrack(f.slug)).metadataRevision, revision);
  assert.deepEqual(await tempFiles(f.trackDir), []);
});

test("external edits during staging are preserved and reported as a conflict", async (t) => {
  const f = await fixture(t);
  const external =
    '{"title":"External","artist":"Toshi","key":"F Minor","bpm":101}';
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const write = handle.writeFile.bind(handle);
    t.mock.method(
      handle,
      "writeFile",
      async (...writeArgs: Parameters<typeof write>) => {
        await write(...writeArgs);
        await fs.writeFile(f.metadata, external);
      },
    );
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(updateTrackMetadata(f.slug, { title: "App" }), {
    code: "METADATA_CONFLICT",
  });
  assert.equal(await fs.readFile(f.metadata, "utf8"), external);
  assert.deepEqual(await tempFiles(f.trackDir), []);
});

test("exclusive staging refuses a collision without touching someone else's file", async (t) => {
  const f = await fixture(t);
  const id = "11111111-1111-4111-8111-111111111111";
  const temporary = `${f.cover}.tmp-${id}`;
  await fs.writeFile(temporary, "owned by another operation");
  t.mock.method(crypto, "randomUUID", () => id);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    writeAtomicFile(f.cover, (handle) => handle.writeFile("new")),
    { code: "EEXIST" },
  );
  assert.equal(
    await fs.readFile(temporary, "utf8"),
    "owned by another operation",
  );
});

test("invalid metadata does not write, and a later valid patch still works", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.metadata);
  await assert.rejects(updateTrackMetadata(f.slug, { bpm: -1 }), {
    code: "METADATA_INVALID",
  });
  assert.deepEqual(await fs.readFile(f.metadata), before);
  await updateTrackMetadata(f.slug, { bpm: 110 });
  assert.equal((await inspectTrack(f.slug)).metadata?.bpm, 110);
  assert.deepEqual(await tempFiles(f.trackDir), []);
});

test("metadata write failure is structured and releases the mutation lock", async (t) => {
  const f = await fixture(t);
  const before = await fs.readFile(f.metadata);
  const mock = t.mock.method(fs, "rename", async () => {
    throw new Error("disk error");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(updateTrackMetadata(f.slug, { bpm: 123 }), {
    code: "METADATA_WRITE_FAILED",
  });
  assert.deepEqual(await fs.readFile(f.metadata), before);
  assert.deepEqual(await tempFiles(f.trackDir), []);
  mock.mock.restore();
  syncBuiltinESMExports();
  await updateTrackMetadata(f.slug, { bpm: 124 });
  assert.equal((await inspectTrack(f.slug)).metadata?.bpm, 124);
});
