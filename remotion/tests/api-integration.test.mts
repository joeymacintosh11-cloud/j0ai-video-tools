import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { Writable } from "node:stream";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { handleRequest } from "../server/app.ts";
import { fixture, tempFiles } from "./fixtures.mts";

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
  return { port: address.port, base: `http://127.0.0.1:${address.port}` };
};

test("raw malformed HTTP target returns 400 and the server remains healthy", async (t) => {
  const { port, base } = await api(t);
  const socket = connect(port, "127.0.0.1");
  let reply = "";
  socket.setEncoding("utf8");
  socket.on("data", (data) => {
    reply += data;
  });
  socket.end(
    "GET //[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
  );
  await once(socket, "close");
  assert.match(reply, /400 Bad Request/);
  assert.match(reply, /INVALID_REQUEST/);
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("metadata API accepts current revisions and legacy PATCH, rejects stale revisions", async (t) => {
  const f = await fixture(t);
  const { base } = await api(t);
  const url = `${base}/api/tracks/${f.slug}`;
  const initial = await (await fetch(url)).json();
  const patch = (value: number, revision?: string) =>
    fetch(`${url}/metadata`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(revision ? { "if-match": `"${revision}"` } : {}),
      },
      body: JSON.stringify({ bpm: value }),
    });
  assert.equal((await patch(120, initial.data.metadataRevision)).status, 200);
  const before = await fs.readFile(f.metadata);
  const stale = await patch(130, initial.data.metadataRevision);
  assert.equal(stale.status, 412);
  assert.equal((await stale.json()).error.code, "METADATA_CONFLICT");
  assert.deepEqual(await fs.readFile(f.metadata), before);
  assert.equal((await patch(140)).status, 200);
  assert.deepEqual(await tempFiles(f.trackDir), []);
});

test("upload disk errors return structured JSON and leave the API healthy", async (t) => {
  const f = await fixture(t);
  const { base } = await api(t);
  await fs.writeFile(f.cover, "original");
  t.mock.method(fs, "open", async () => {
    throw new Error("simulated disk error");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const response = await fetch(`${base}/api/tracks/${f.slug}/cover`, {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
  });
  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, "UPLOAD_FAILED");
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal(await fs.readFile(f.cover, "utf8"), "original");
  assert.deepEqual(await tempFiles(f.trackDir), []);
});

test("invalid streamed uploads return structured errors rather than resetting HTTP", async (t) => {
  const f = await fixture(t);
  const { base } = await api(t);
  const response = await fetch(`${base}/api/tracks/${f.slug}/cover`, {
    method: "PUT",
    headers: { "content-type": "image/png" },
    body: new Uint8Array(100000),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "UPLOAD_INVALID");
  assert.deepEqual(await tempFiles(f.trackDir), []);
});

test("interrupted HTTP upload removes its staging file and keeps the old cover", async (t) => {
  const f = await fixture(t);
  const { base, port } = await api(t);
  await fs.writeFile(f.cover, "original");
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  socket.write(
    `PUT /api/tracks/${f.slug}/cover HTTP/1.1\r\nHost: localhost\r\nContent-Type: image/png\r\nContent-Length: 100000\r\n\r\n`,
  );
  socket.write(
    Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      Buffer.alloc(1000),
    ]),
  );
  for (let i = 0; i < 100 && (await tempFiles(f.trackDir)).length === 0; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.equal((await tempFiles(f.trackDir)).length, 1);
  socket.destroy();
  for (let i = 0; i < 100 && (await tempFiles(f.trackDir)).length > 0; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(await tempFiles(f.trackDir), []);
  assert.equal(await fs.readFile(f.cover, "utf8"), "original");
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
});

test("disk failure responds even while the HTTP uploader is waiting to send more", async (t) => {
  const f = await fixture(t);
  const { port } = await api(t);
  const open = fs.open;
  t.mock.method(fs, "open", async (...args: Parameters<typeof open>) => {
    const handle = await open(...args);
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback(new Error("disk full"));
      },
    });
    t.mock.method(handle, "createWriteStream", () => output);
    return handle;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const socket = connect(port, "127.0.0.1");
  t.after(() => socket.destroy());
  socket.setEncoding("utf8");
  const response = new Promise<string>((resolve, reject) => {
    let data = "";
    const timeout = setTimeout(
      () => reject(new Error("upload error response stalled")),
      1000,
    );
    socket.on("data", (chunk) => {
      data += chunk;
      if (data.includes("UPLOAD_FAILED")) {
        clearTimeout(timeout);
        resolve(data);
      }
    });
    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  socket.write(
    `PUT /api/tracks/${f.slug}/cover HTTP/1.1\r\nHost: localhost\r\nContent-Type: image/png\r\nContent-Length: 100000\r\n\r\n`,
  );
  socket.write(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.match(await response, /500 Internal Server Error/);
  assert.deepEqual(await tempFiles(f.trackDir), []);
});
