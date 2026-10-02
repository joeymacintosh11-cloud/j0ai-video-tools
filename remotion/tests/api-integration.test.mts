import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import { connect } from "node:net";
import { Writable } from "node:stream";
import { once } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { handleRequest } from "../server/app.ts";
import { CONTENT_METADATA_SETTINGS_FILE } from "../services/content/metadataTemplateSettings.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import { fixture, tempFiles } from "./fixtures.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

await isolateRenderJournalForThisFile();

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

test("PATCH metadata persists contentMetadataOverrides through the HTTP route, not just the service layer", async (t) => {
  const f = await fixture(t);
  const { base } = await api(t);
  const url = `${base}/api/tracks/${f.slug}`;

  const patchWith = (body: unknown, revision?: string) =>
    fetch(`${url}/metadata`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        ...(revision ? { "if-match": `"${revision}"` } : {}),
      },
      body: JSON.stringify(body),
    });

  const initial = await (await fetch(url)).json();
  const saved = await patchWith(
    { contentMetadataOverrides: { youtube: { titleTemplate: "{title} [Exclusive]" } } },
    initial.data.metadataRevision,
  );
  assert.equal(saved.status, 200);
  const savedBody = await saved.json();
  assert.deepEqual(savedBody.data.metadata.contentMetadataOverrides, {
    youtube: { titleTemplate: "{title} [Exclusive]" },
  });

  // On disk, not just in the response — the route must actually have read
  // the field out of the request body before handing it to the service.
  const onDisk = JSON.parse(await fs.readFile(f.metadata, "utf8"));
  assert.deepEqual(onDisk.contentMetadataOverrides, { youtube: { titleTemplate: "{title} [Exclusive]" } });

  // null clears every override.
  const cleared = await patchWith({ contentMetadataOverrides: null }, savedBody.data.metadataRevision);
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).data.metadata.contentMetadataOverrides, undefined);

  // An unknown placeholder is refused with the same TEMPLATE_INVALID the
  // service layer and the global settings endpoint both use.
  const invalid = await patchWith(
    { contentMetadataOverrides: { youtube: { titleTemplate: "{mood}" } } },
    (await (await fetch(url)).json()).data.metadataRevision,
  );
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "TEMPLATE_INVALID");

  const unexpected = await patchWith({ title: "Valid", contentMetadataOverride: {} });
  assert.equal(unexpected.status, 400);
  assert.equal((await unexpected.json()).error.code, "INVALID_REQUEST");
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
  const { renderManager } = await import("../services/workflows/renderManager.ts");
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

test("delivery history validates every filter and bounds the response", async (t) => {
  const { base } = await api(t);

  const get = async (query: string) => {
    const response = await fetch(`${base}/api/delivery-history${query}`);
    return { status: response.status, body: await response.json() };
  };

  // Every parameter is checked before the log is touched, so a typo is a 400
  // rather than a silently ignored filter or an unbounded answer.
  for (const query of [
    "?limit=0",
    "?limit=501",
    "?limit=lots",
    "?limit=1.5",
    "?order=sideways",
    "?from=last%20tuesday",
    "?to=nonsense",
    "?track=../../etc",
    `?preset=${"x".repeat(80)}`,
  ]) {
    const refused = await get(query);
    assert.equal(refused.status, 400, query);
    assert.match(refused.body.error.code, /INVALID_REQUEST|INVALID_SLUG/, query);
  }

  // The bound is reported, so a client knows the answer is a page.
  const defaulted = await get("");
  assert.equal(defaulted.status, 200);
  assert.equal(defaulted.body.data.limit, 50);
  assert.equal(Array.isArray(defaulted.body.data.events), true);

  // A relative period is accepted as well as an ISO instant.
  assert.equal((await get("?from=7d&order=oldest&limit=5")).status, 200);
  assert.equal((await get("?from=2026-09-01T00:00:00.000Z")).status, 200);

  // Read-only: the collection takes GET, and reconcile takes POST, and
  // nothing here accepts a path.
  const wrongMethod = await fetch(`${base}/api/delivery-history`, { method: "POST" });
  assert.equal(wrongMethod.status, 404);
  const reconcileGet = await fetch(`${base}/api/delivery-history/reconcile`);
  assert.equal(reconcileGet.status, 404);
  const reconciled = await fetch(`${base}/api/delivery-history/reconcile`, {
    method: "POST",
  });
  assert.equal(reconciled.status, 200);
});

test("destination health rejects empty, malformed and oversized track scopes", async (t) => {
  const { base } = await api(t);
  for (const query of [
    "?track=",
    "?track=%20",
    "?track=ghetto-geek&track=",
    "?track=..%2Foutside",
    `?${Array.from({ length: 101 }, () => "track=ghetto-geek").join("&")}`,
  ]) {
    const response = await fetch(`${base}/api/destination-health${query}`);
    assert.equal(response.status, 400, query);
    assert.match((await response.json()).error.code, /INVALID_REQUEST|INVALID_SLUG/, query);
  }
  const repeated = await fetch(`${base}/api/destination-health?track=ghetto-geek&track=ghetto-geek`);
  assert.equal(repeated.status, 200);
  const body = await repeated.json();
  assert.equal(body.data.catalogue, false);
  assert.ok(body.data.tracks.length <= 1);
  assert.equal((await fetch(`${base}/api/destination-health`, { method: "POST" })).status, 404);
});

test("destination fix apply validates exact-job confirmation input", async (t) => {
  const { base } = await api(t);
  const post = (followJobs: unknown) => fetch(`${base}/api/destination-health/apply-plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ tracks: ["ghetto-geek"], actionIds: ["action"], waitForCompletion: true, followJobs }),
  });
  for (const value of ["job", [{ actionId: "action" }], [{ actionId: 4, jobId: "job" }]]) {
    const response = await post(value);
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }
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

test("the existing exact-job cancel route is idempotent while active and rejects terminal or unknown jobs", async (t) => {
  const childProcess = (await import("node:child_process")).default;
  const { Worker } = await import("./managerHarness.mts");
  class CountingWorker extends Worker {
    cancelMessages = 0;
    override send(message?: unknown) {
      if ((message as { type?: string })?.type === "cancel") this.cancelMessages++;
      return true;
    }
  }
  const worker = new CountingWorker();
  worker.pid = 67890;
  t.mock.method(childProcess, "fork", () => worker);
  syncBuiltinESMExports();
  t.after(() => {
    worker.emit("message", { type: "cancelled" });
    worker.emit("exit", 0, null);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const f = await fixture(t);
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  const { base } = await api(t);
  const started = await fetch(`${base}/api/tracks/${f.slug}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ preset: "square-1x1" }),
  });
  assert.equal(started.status, 200);
  const jobId = (await started.json()).data.jobId as string;
  const cancel = () => fetch(`${base}/api/renders/${jobId}/cancel`, { method: "POST" });

  assert.equal((await cancel()).status, 200);
  assert.equal((await cancel()).status, 200);
  assert.equal(worker.cancelMessages, 1);

  worker.emit("message", { type: "cancelled" });
  worker.emit("exit", 0, null);
  const terminal = await (await fetch(`${base}/api/renders/${jobId}`)).json();
  assert.equal(terminal.data.status, "cancelled");

  const tooLate = await cancel();
  assert.equal(tooLate.status, 409);
  assert.equal((await tooLate.json()).error.code, "RENDER_NOT_CANCELLABLE");

  const unknown = await fetch(`${base}/api/renders/not-a-job/cancel`, { method: "POST" });
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "RENDER_JOB_NOT_FOUND");
});

/* -------------------------------------------------------------------- *
 * Content package
 * -------------------------------------------------------------------- */

test("GET /api/content-package returns a derived, platform-facing view", async (t) => {
  const f = await fixture(t, { exportPresets: ["youtube-16x9"] });
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  const { base } = await api(t);

  const response = await fetch(`${base}/api/content-package?track=${f.slug}`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.slug, f.slug);
  assert.equal(body.data.mode, "intent");
  // Only the declared platform is selected in intent mode.
  assert.equal(body.data.counts.selected, 1);
  const youtube = body.data.platforms.find(
    (p: { platformId: string }) => p.platformId === "youtube",
  );
  assert.equal(youtube.readiness, "missing");
  assert.equal(youtube.outputFilename, `${f.slug}-youtube.mp4`);
});

test("GET /api/content-package with mode=full ignores declared intent", async (t) => {
  const f = await fixture(t, { exportPresets: ["youtube-16x9"] });
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  const { base } = await api(t);

  const response = await fetch(
    `${base}/api/content-package?track=${f.slug}&mode=full`,
  );
  const body = await response.json();

  assert.equal(body.data.mode, "full");
  assert.equal(body.data.counts.selected, 3);
});

test("GET /api/content-package with a platform override selects exactly that set", async (t) => {
  const f = await fixture(t, { exportPresets: ["youtube-16x9"] });
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  const { base } = await api(t);

  const response = await fetch(
    `${base}/api/content-package?track=${f.slug}&platform=reels&platform=instagram-square`,
  );
  const body = await response.json();

  assert.equal(body.data.mode, "custom");
  const selected = body.data.platforms
    .filter((p: { selected: boolean }) => p.selected)
    .map((p: { platformId: string }) => p.platformId)
    .sort();
  assert.deepEqual(selected, ["instagram-square", "reels"]);
});

test("GET /api/content-package rejects an unknown platform and a missing track", async (t) => {
  const { base } = await api(t);

  const badPlatform = await fetch(
    `${base}/api/content-package?track=ghetto-geek&platform=snapchat`,
  );
  assert.equal(badPlatform.status, 400);
  assert.equal((await badPlatform.json()).error.code, "INVALID_PLATFORM");

  const noTrackParam = await fetch(`${base}/api/content-package`);
  assert.equal(noTrackParam.status, 400);

  const missingTrack = await fetch(
    `${base}/api/content-package?track=does-not-exist-${Date.now()}`,
  );
  assert.equal(missingTrack.status, 404);
  assert.equal((await missingTrack.json()).error.code, "TRACK_NOT_FOUND");
});

/* -------------------------------------------------------------------- *
 * Content metadata templates
 * -------------------------------------------------------------------- */

test("GET /api/content-metadata-settings reads real settings without ever writing", async (t) => {
  const { base } = await api(t);

  const response = await fetch(`${base}/api/content-metadata-settings`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(typeof body.data.settingsPath, "string");
  assert.match(body.data.settingsPath, /content-metadata\.local\.json$/);
  // Whatever this machine's real file holds (most commonly nothing at all),
  // reading it is never itself a write.
  assert.equal(typeof body.data.templates, "object");
  assert.match(body.data.revision, /^(missing|[a-f0-9]{64})$/);
});

test("settings PATCH rejects empty bodies and invalid revisions before writing", async (t) => {
  const { base } = await api(t);
  const before = await (await fetch(`${base}/api/content-metadata-settings`)).json();
  for (const [body, headers] of [
    [{}, { "content-type": "application/json" }],
    [{ youtube: {} }, { "content-type": "application/json" }],
    [{ youtube: { titleTemplate: "{title}" } }, { "content-type": "application/json", "if-match": "bogus" }],
  ] as const) {
    const response = await fetch(`${base}/api/content-metadata-settings`, {
      method: "PATCH", headers, body: JSON.stringify(body),
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }
  const after = await (await fetch(`${base}/api/content-metadata-settings`)).json();
  assert.deepEqual(after.data, before.data);
});

test("PATCH /api/content-metadata-settings rejects an unknown placeholder and writes nothing", async (t) => {
  const { base } = await api(t);

  const before = await (await fetch(`${base}/api/content-metadata-settings`)).json();

  const response = await fetch(`${base}/api/content-metadata-settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ youtube: { titleTemplate: "{mood}" } }),
  });
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, "TEMPLATE_INVALID");
  assert.match(body.error.message, /mood/);

  const after = await (await fetch(`${base}/api/content-metadata-settings`)).json();
  assert.deepEqual(after.data, before.data, "a refused change writes nothing");
});

test("PATCH /api/content-metadata-settings rejects an unknown platform and field, structurally", async (t) => {
  const { base } = await api(t);

  for (const body of [{ tiktok: { captionTemplate: "{title}" } }, { youtube: { thumbnailTemplate: "{title}" } }]) {
    const response = await fetch(`${base}/api/content-metadata-settings`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error.code, "TEMPLATE_INVALID");
  }
});

test("GET /api/content-package reflects a configured global template, via the real settings-read path", async (t) => {
  const f = await fixture(t, { exportPresets: ["youtube-16x9"] });
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");

  const realReadFile = fs.readFile.bind(fs);
  t.mock.method(fs, "readFile", (async (...args: Parameters<typeof fs.readFile>) => {
    if (String(args[0]) === CONTENT_METADATA_SETTINGS_FILE) {
      return JSON.stringify({
        schemaVersion: 1,
        templates: { youtube: { titleTemplate: "{title} — configured globally" } },
      });
    }
    return realReadFile(...args);
  }) as typeof fs.readFile);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const { base } = await api(t);
  const response = await fetch(`${base}/api/content-package?track=${f.slug}`);
  const body = await response.json();

  const youtube = body.data.platforms.find((p: { platformId: string }) => p.platformId === "youtube");
  assert.equal(youtube.title, "Fixture — configured globally");
  assert.equal(body.data.templatesProblem, null);
});

/* ------------------------------------------------------------------ *
 * Batch Content Package Generation
 * ------------------------------------------------------------------ */

/** A fixture with a cover/beat on disk and a helper to publish a "current" export for one preset. */
const batchFixture = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const f = await fixture(t, extra);
  await fs.writeFile(f.cover, "cover");
  await fs.writeFile(f.beat, "audio");
  t.after(() => fs.rm(f.outputDir, { recursive: true, force: true }));
  const props = buildTrackProps({
    slug: f.slug,
    metadata: parseTrackMetadata(JSON.parse(await fs.readFile(f.metadata, "utf8")), "fixture"),
    analysisAvailable: true,
  });
  const publish = (presetId: "youtube-16x9" | "vertical-9x16" | "square-1x1") =>
    publishExport(f.slug, presetId, fingerprintInputs(props, presetId), async (file) => {
      await fs.writeFile(file, "successful video");
    });
  return { ...f, publish };
};

const postBatch = (base: string, action: "inspect" | "plan" | "apply", body: unknown) =>
  fetch(`${base}/api/content-package/batch/${action}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("POST /api/content-package/batch/inspect aggregates several tracks, matching the worked example", async (t) => {
  const a = await batchFixture(t, { exportPresets: ["youtube-16x9"] });
  await a.publish("youtube-16x9");
  const b = await batchFixture(t, { exportPresets: ["youtube-16x9"] });
  // b's youtube export is left missing.

  const { base } = await api(t);
  const response = await postBatch(base, "inspect", { tracks: [a.slug, b.slug] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.totals.tracks, 2);
  assert.equal(body.data.totals.readyTargets, 1);
  assert.equal(body.data.totals.missingTargets, 1);
});

test("POST /api/content-package/batch/inspect rejects an empty track list", async (t) => {
  const { base } = await api(t);
  const response = await postBatch(base, "inspect", { tracks: [] });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_REQUEST");
});

test("POST /api/content-package/batch/inspect rejects a batch over the maximum size", async (t) => {
  const { base } = await api(t);
  const response = await postBatch(base, "inspect", {
    tracks: Array.from({ length: 101 }, (_, i) => `track-${i}`),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_REQUEST");
});

test("POST /api/content-package/batch/inspect de-duplicates a repeated track and reports it", async (t) => {
  const a = await batchFixture(t);
  const { base } = await api(t);
  const response = await postBatch(base, "inspect", { tracks: [a.slug, a.slug] });
  const body = await response.json();
  assert.equal(body.data.totals.tracks, 1);
  assert.deepEqual(body.data.duplicates, [a.slug]);
});

test("POST /api/content-package/batch/inspect reports a not-found track without failing the rest", async (t) => {
  const a = await batchFixture(t, { exportPresets: ["youtube-16x9"] });
  await a.publish("youtube-16x9");
  const { base } = await api(t);
  const response = await postBatch(base, "inspect", { tracks: [a.slug, "batch-probe-missing-track"] });
  const body = await response.json();
  assert.equal(body.data.totals.tracks, 1);
  assert.equal(body.data.invalid.length, 1);
  assert.equal(body.data.invalid[0].slug, "batch-probe-missing-track");
});

test("POST /api/content-package/batch/inspect rejects an unknown platform", async (t) => {
  const a = await batchFixture(t);
  const { base } = await api(t);
  const response = await postBatch(base, "inspect", { tracks: [a.slug], platforms: ["twitter"] });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "INVALID_PLATFORM");
});

test("POST /api/content-package/batch/plan classifies renderable, ready and blocked without queueing anything", async (t) => {
  const ready = await batchFixture(t, { exportPresets: ["youtube-16x9"] });
  await ready.publish("youtube-16x9");
  const missing = await batchFixture(t, { exportPresets: ["youtube-16x9"] });
  const blocked = await fixture(t, { bpm: "not-a-number" });

  const { base } = await api(t);
  const response = await postBatch(base, "plan", {
    tracks: [ready.slug, missing.slug, blocked.slug],
    platforms: ["youtube"],
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.ready.length, 1);
  assert.equal(body.data.renderable.length, 1);
  assert.equal(body.data.renderable[0].kind, "render_missing");
  assert.equal(body.data.blocked.length, 1);

  // Planning never queues: the missing target still reads as missing, not
  // rendering/queued, immediately afterwards.
  const detail = await (await fetch(`${base}/api/tracks/${missing.slug}`)).json();
  assert.equal(detail.data.exports[0].status, "missing");
});

test("POST /api/content-package/batch/apply is a successful no-op when everything is already ready", async (t) => {
  const a = await batchFixture(t, { exportPresets: ["youtube-16x9"] });
  await a.publish("youtube-16x9");
  const { base } = await api(t);
  const response = await postBatch(base, "apply", { tracks: [a.slug], platforms: ["youtube"] });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.data.batchId, null);
  assert.equal(body.data.nothingToDo, true);
  assert.equal(body.data.alreadyReady.length, 1);
});

test("POST /api/content-package/batch/apply queues missing targets through the existing render queue", async (t) => {
  const childProcess = (await import("node:child_process")).default;
  const { Worker } = await import("./managerHarness.mts");
  const { renderManager } = await import("../services/workflows/renderManager.ts");
  const worker = new Worker();
  worker.pid = 54321;
  t.mock.method(childProcess, "fork", () => worker);
  syncBuiltinESMExports();
  t.after(() => {
    worker.emit("message", { type: "cancelled" });
    worker.emit("exit", 0, null);
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const a = await batchFixture(t, { exportPresets: ["youtube-16x9"] });
  const { base } = await api(t);
  const response = await postBatch(base, "apply", {
    tracks: [a.slug], platforms: ["youtube"], wait: true, timeoutMs: 0,
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.data.batchId);
  assert.equal(body.data.queued.length, 1);
  assert.equal(body.data.queued[0].slug, a.slug);
  assert.equal(body.data.nothingToDo, false);
  assert.equal(body.data.timedOut, true);
  assert.deepEqual(body.data.jobReferences, [{
    actionId: `${a.slug}::youtube::youtube-16x9`,
    slug: a.slug,
    platformId: "youtube",
    presetId: "youtube-16x9",
    jobId: body.data.renderBatch.jobs[0].id,
    outcome: "queued",
  }]);

  const adopted = await (await postBatch(base, "apply", {
    tracks: [a.slug], platforms: ["youtube"], wait: true, timeoutMs: 0,
  })).json();
  assert.equal(adopted.data.batchId, null);
  assert.equal(adopted.data.adopted.length, 1);
  assert.equal(adopted.data.jobReferences[0].jobId, body.data.jobReferences[0].jobId);
  assert.equal(adopted.data.jobReferences[0].outcome, "adopted");
  assert.equal(renderManager.getJob(body.data.jobReferences[0].jobId).status !== "failed", true);


  const view = (await (await fetch(`${base}/api/tracks/${a.slug}`)).json()).data.exports[0];
  assert.equal(view.status, "rendering");

  renderManager.cancelBatch(body.data.batchId);
});

test("apply revalidates immediately before queueing — a target published after /plan is not re-queued", async (t) => {
  const a = await batchFixture(t, { exportPresets: ["youtube-16x9"] });
  const { base } = await api(t);

  const planned = await (await postBatch(base, "plan", { tracks: [a.slug], platforms: ["youtube"] })).json();
  assert.equal(planned.data.renderable.length, 1);

  // Another caller (or a previous apply) finishes the render before this
  // apply's own fresh read.
  await a.publish("youtube-16x9");

  const applied = await (await postBatch(base, "apply", { tracks: [a.slug], platforms: ["youtube"] })).json();
  assert.equal(applied.data.batchId, null);
  assert.equal(applied.data.nothingToDo, true);
  assert.equal(applied.data.alreadyReady.length, 1);
});

test("POST /api/content-package/batch/apply rejects a malformed body before touching anything", async (t) => {
  const { base } = await api(t);
  for (const body of [{}, { tracks: "not-an-array" }, { tracks: [] }, { tracks: [123] }]) {
    const response = await postBatch(base, "apply", body);
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal((await response.json()).error.code, "INVALID_REQUEST");
  }
});
