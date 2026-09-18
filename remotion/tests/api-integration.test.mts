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

test("export-missing plans from intent, and says what it will not guess", async (t) => {
  const f = await fixture(t, { exportPresets: ["youtube-16x9"] });
  await fs.writeFile(f.cover, "placeholder");
  await fs.writeFile(f.beat, "placeholder");
  const { base } = await api(t);

  const post = async (body: unknown) => {
    const response = await fetch(`${base}/api/export-missing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  // No presets named: the track's own exportPresets decide. Nothing is queued,
  // because this is a dry run.
  const intent = await post({ tracks: [f.slug], dryRun: true });
  assert.equal(intent.status, 200);
  assert.deepEqual(
    intent.body.data.missing.map(
      (target: { presetId: string }) => target.presetId,
    ),
    ["youtube-16x9"],
  );
  assert.equal(intent.body.data.batchId, null);
  assert.equal(intent.body.data.catalogue, false);
  assert.equal(intent.body.data.intendedTargets.length, 1);

  // Named presets override that intent for this request.
  const override = await post({
    tracks: [f.slug],
    presets: ["square-1x1"],
    dryRun: true,
  });
  assert.deepEqual(
    override.body.data.missing.map(
      (target: { presetId: string }) => target.presetId,
    ),
    ["square-1x1"],
  );

  // The catalogue has to be asked for outright, and cannot be combined.
  const catalogue = await post({ catalogue: true, dryRun: true });
  assert.equal(catalogue.body.data.catalogue, true);
  assert.ok(catalogue.body.data.tracks >= 1);

  const neither = await post({ dryRun: true });
  assert.equal(neither.status, 400);
  assert.equal(neither.body.error.code, "INVALID_REQUEST");

  const both = await post({ tracks: [f.slug], catalogue: true, dryRun: true });
  assert.equal(both.body.ok, false);
  assert.match(both.body.error.message, /not both/);
});

test("the track view separates what a track intends from what it has", async (t) => {
  const f = await fixture(t, { exportPresets: ["vertical-9x16"] });
  const { base } = await api(t);

  const track = (await (await fetch(`${base}/api/tracks/${f.slug}`)).json())
    .data;

  assert.deepEqual(track.exportPresets, ["vertical-9x16"]);
  assert.deepEqual(
    track.exports.map((output: { presetId: string; intended: boolean }) => [
      output.presetId,
      output.intended,
    ]),
    [
      ["youtube-16x9", false],
      ["vertical-9x16", true],
      ["square-1x1", false],
    ],
  );
  assert.equal(
    track.exports.every((output: { present: boolean }) => !output.present),
    true,
    "intending a format is not the same as having rendered it",
  );

  // A track that declares nothing reports null, not an invented list, while
  // every format still counts as intended.
  const plain = await fixture(t);
  const other = (await (await fetch(`${base}/api/tracks/${plain.slug}`)).json())
    .data;

  assert.equal(other.exportPresets, null);
  assert.equal(
    other.exports.every((output: { intended: boolean }) => output.intended),
    true,
  );
});

test("freshness API reports stale reasons and all three plan modes without queueing", async (t) => {
  const { publishExport } = await import("../services/render/publishExport.ts");
  const { fingerprintInputs } =
    await import("../services/tracks/exportManifest.ts");
  const { buildTrackProps } =
    await import("../services/tracks/buildTrackProps.ts");
  const { inspectTrack } = await import("../services/tracks/inspectTrack.ts");
  const f = await fixture(t);
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  t.after(() => fs.rm(f.outputDir, { recursive: true, force: true }));
  const inspection = await inspectTrack(f.slug);
  const props = buildTrackProps({
    slug: f.slug,
    metadata: inspection.metadata!,
    analysisAvailable: true,
  });
  await publishExport(
    f.slug,
    "youtube-16x9",
    fingerprintInputs(props, "youtube-16x9"),
    async (file) => {
      await fs.writeFile(file, "valid output");
    },
  );
  await fs.writeFile(f.cover, "edited cover");
  const { base } = await api(t);
  const track = (await (await fetch(`${base}/api/tracks/${f.slug}`)).json())
    .data;
  assert.equal(track.exports[0].freshness, "stale");
  assert.equal(track.exports[0].status, "stale");
  assert.equal(track.exports[0].present, true);
  assert.deepEqual(track.exports[0].staleReasons, ["cover_changed"]);
  for (const [mode, expected] of [
    [undefined, 2],
    ["stale", 1],
    ["missing-and-stale", 3],
  ] as const) {
    const response = await fetch(`${base}/api/export-missing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracks: [f.slug], mode, dryRun: true }),
    });
    assert.equal(response.status, 200);
    const { data } = await response.json();
    assert.equal(data.selected.length, expected);
    assert.equal(data.mode, mode ?? "missing");
    assert.equal(data.missing.length, 2);
    assert.equal(data.stale.length, 1);
    assert.equal(data.batchId, null);
    assert.deepEqual(data.queued, []);
  }
  const bad = await fetch(`${base}/api/export-missing`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      tracks: [f.slug],
      mode: "overwrite-everything",
      dryRun: true,
    }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "INVALID_REQUEST");
});

test("stale execution queues replacements once and exposes rendering over disk freshness", async (t) => {
  const childProcess = (await import("node:child_process")).default;
  const { Worker } = await import("./managerHarness.mts");
  const { renderManager } = await import("../server/services/renderManager.ts");
  const worker = new Worker();
  worker.pid = 12345;
  t.mock.method(childProcess, "fork", () => worker);
  syncBuiltinESMExports();
  t.after(() => {
    worker.emit("message", { type: "cancelled" });
    worker.emit("exit", 0, null);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const f = await fixture(t, { exportPresets: ["vertical-9x16"] });
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  await fs.mkdir(f.outputDir, { recursive: true });
  await fs.writeFile(`${f.outputDir}/vertical-9x16.mp4`, "legacy export");
  t.after(() => fs.rm(f.outputDir, { recursive: true, force: true }));
  const { base } = await api(t);
  const post = () =>
    fetch(`${base}/api/export-missing`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tracks: [f.slug], mode: "stale" }),
    }).then((response) => response.json());
  const replies = await Promise.all([post(), post()]);
  assert.equal(
    replies.reduce((sum, reply) => sum + reply.data.queued.length, 0),
    1,
  );
  const started = replies.find((reply) => reply.data.batchId !== null)!;
  const skipped = replies.find((reply) => reply.data.batchId === null)!;
  assert.equal(skipped.data.nothingToDo, true);
  assert.equal(started.data.queued[0].presetId, "vertical-9x16");
  const view = (await (await fetch(`${base}/api/tracks/${f.slug}`)).json()).data
    .exports[1];
  assert.equal(view.freshness, "stale");
  assert.equal(view.status, "rendering");
  assert.equal(view.present, true);
  renderManager.cancelBatch(started.data.batchId);
});

test("delivery settings refuse an unusable destination and change nothing", async (t) => {
  const { base } = await api(t);

  const put = (body: unknown) =>
    fetch(`${base}/api/delivery/settings`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  const before = await (await fetch(`${base}/api/delivery/settings`)).json();
  assert.equal(before.ok, true);
  assert.equal(typeof before.data.settingsPath, "string");

  for (const body of [
    { root: "relative/path" },
    { root: "/definitely/not/here" },
    { root: process.cwd() },
    { autoDeliver: "yes" },
  ]) {
    const response = await put(body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }

  const after = await (await fetch(`${base}/api/delivery/settings`)).json();
  assert.deepEqual(after.data, before.data, "a refused change writes nothing");
});

test("delivery requests name tracks, never paths", async (t) => {
  const f = await fixture(t);
  const { base } = await api(t);

  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  // Scope has to be stated, exactly as for export-missing, so a request that
  // forgot its tracks cannot become a catalogue-wide operation.
  const neither = await post("/api/delivery/deliver", { dryRun: true });
  assert.equal(neither.status, 400);
  assert.equal(neither.body.error.code, "INVALID_REQUEST");

  const both = await post("/api/delivery/deliver", {
    tracks: [f.slug],
    catalogue: true,
    dryRun: true,
  });
  assert.match(both.body.error.message, /not both/);

  // A named track is planned, and reports why it cannot be delivered rather
  // than failing: the fixture has no cover or audio.
  const named = await post("/api/delivery/deliver", {
    tracks: [f.slug],
    dryRun: true,
  });
  assert.equal(named.status, 200);
  assert.equal(named.body.data.dryRun, true);
  assert.deepEqual(named.body.data.delivered, []);
  assert.equal(named.body.data.invalid[0].slug, f.slug);

  // Reveal accepts a slug and a format only; a traversal attempt is refused
  // before anything is resolved or opened.
  const traversal = await post("/api/delivery/reveal", { slug: "../../etc" });
  assert.equal(traversal.status, 400);
  assert.equal(traversal.body.error.code, "INVALID_SLUG");
});

test("a render refused for a locked target answers 409, not a queued job", async (t) => {
  const { acquireRenderTargetLock, inspectRenderTargetLock } = await import(
    "../services/render/renderLock.ts"
  );
  // Renderable, so the request gets past validation and reaches the lock check.
  const f = await fixture(t);
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  const { base } = await api(t);

  const lock = acquireRenderTargetLock(f.slug, "square-1x1", {
    jobId: "held-elsewhere",
  });
  t.after(() => lock.release());

  const response = await fetch(`${base}/api/tracks/${f.slug}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preset: "square-1x1" }),
  });
  const body = await response.json();

  assert.equal(response.status, 409);
  assert.equal(body.error.code, "RENDER_TARGET_LOCKED");
  assert.match(body.error.message, /another process/);
  assert.match(body.error.message, /held-elsewhere/, "names the holding job");

  // No job was created, so the refusal really did stop a second render rather
  // than queueing one that would fail.
  const jobs = await (await fetch(`${base}/api/renders`)).json();
  assert.equal(
    jobs.data.some((job: { slug: string }) => job.slug === f.slug),
    false,
  );

  // Releasing frees the target again. Deliberately not started here: that would
  // fork a worker and launch Chromium for a test about HTTP status codes.
  lock.release();
  assert.equal(
    inspectRenderTargetLock(f.slug, "square-1x1").state,
    "free",
  );
});
