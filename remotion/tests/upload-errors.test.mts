import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { Readable, Writable } from "node:stream";
import test, { type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { uploadTrackAsset } from "../services/tracks/uploadTrackAsset.ts";
import { fixture, tempFiles } from "./fixtures.mts";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const failure = () =>
  Object.assign(new Error("simulated disk failure"), { code: "EIO" });
const restore = (t: TestContext) => {
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
};

for (const stage of ["open", "write", "rename"] as const) {
  test(`upload ${stage} errors reject structurally, preserve the asset and remove temps`, async (t) => {
    const f = await fixture(t);
    const original = Buffer.from("previous asset");
    await fs.writeFile(f.cover, original);
    if (stage === "open") {
      t.mock.method(fs, "open", async () => {
        throw failure();
      });
    } else if (stage === "rename") {
      t.mock.method(fs, "rename", async () => {
        throw failure();
      });
    } else {
      const open = fs.open;
      t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
        const handle = await open(...args);
        // Fail asynchronously while the source is waiting for its next chunk.
        const output = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
            setImmediate(() => output.destroy(failure()));
          },
        });
        t.mock.method(handle, "createWriteStream", () => output);
        return handle;
      });
    }
    restore(t);
    async function* body() {
      yield png;
      await delay(20);
      yield Buffer.alloc(100);
    }
    await assert.rejects(
      uploadTrackAsset({ slug: f.slug, kind: "cover", body: body() }),
      { code: "UPLOAD_FAILED" },
    );
    assert.deepEqual(await fs.readFile(f.cover), original);
    assert.deepEqual(await tempFiles(f.trackDir), []);
  });
}

test("interrupted upload closes its file before cleanup", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.cover, "previous");
  async function* body() {
    yield png;
    throw new Error("client disconnected");
  }
  await assert.rejects(
    uploadTrackAsset({ slug: f.slug, kind: "cover", body: body() }),
    { code: "UPLOAD_FAILED" },
  );
  assert.equal(await fs.readFile(f.cover, "utf8"), "previous");
  assert.deepEqual(await tempFiles(f.trackDir), []);
});

test("invalid and oversized uploads preserve existing assets and clean up", async (t) => {
  const f = await fixture(t);
  await fs.writeFile(f.cover, "previous");
  async function* tooLarge() {
    yield png;
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 26; i++) yield chunk;
  }
  for (const [body, code] of [
    [Readable.from([Buffer.from("not a png")]), "UPLOAD_INVALID"],
    [tooLarge(), "UPLOAD_TOO_LARGE"],
  ] as const) {
    await assert.rejects(
      uploadTrackAsset({ slug: f.slug, kind: "cover", body }),
      { code },
    );
    assert.equal(await fs.readFile(f.cover, "utf8"), "previous");
    assert.deepEqual(await tempFiles(f.trackDir), []);
  }
});
