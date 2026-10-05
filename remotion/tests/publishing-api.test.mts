import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import { handleRequest } from "../server/app.ts";
import { isolatePublishing, metadata, publishingTrack } from "./publishingHarness.mts";

/**
 * /api/publish/* end to end over HTTP, with the real destination registry
 * (local mock destinations only), an isolated publishing root and settings
 * file, and synthetic exports. No network beyond loopback.
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
  const base = `http://127.0.0.1:${address.port}`;
  const call = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // Loosely typed on purpose: these tests assert the wire format field by field.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, json: (await response.json()) as { ok: boolean; data: any; error: { code: string; message: string } } };
  };
  return { call };
};

const body = (slug: string, overrides: Record<string, unknown> = {}) => ({
  destination: "local-mock",
  source: { track: slug, format: "youtube-16x9", renderer: "remotion" },
  metadata: metadata(),
  ...overrides,
});

test("API: destinations list status and capabilities without secrets; unknown ids fail explicitly", async (t) => {
  const iso = await isolatePublishing(t);
  await iso.writeSettings({ schemaVersion: 1, destinations: { "local-mock": { accountId: "studio" } } });
  const { call } = await api(t);
  const list = await call("GET", "/api/publish/destinations");
  assert.equal(list.status, 200);
  const ids = list.json.data.destinations.map((d: { id: string }) => d.id);
  assert.deepEqual(ids, ["local-mock", "local-mock-landscape", "youtube", "instagram", "tiktok"]);
  const mock = list.json.data.destinations[0];
  assert.equal(mock.state, "ready");
  assert.equal(mock.accountId, "studio");
  assert.equal(mock.capabilities.network, false);
  assert.equal(list.json.data.settingsProblem, null);
  assert.equal((await call("GET", "/api/publish/destinations/youtube")).json.data.state, "unavailable");
  const unknown = await call("GET", "/api/publish/destinations/myspace");
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.code, "PUBLISH_DESTINATION_UNKNOWN");
  assert.equal((await call("GET", "/api/publish/nothing")).status, 404);
});

test("API: plan, create, execute, then the receipt is in history and survives a new server", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const first = await api(t);

  const plan = await first.call("POST", "/api/publish/plan", body(f.slug));
  assert.equal(plan.status, 200);
  assert.equal(plan.json.data.ok, true, JSON.stringify(plan.json.data.problems));
  assert.equal(plan.json.data.source.renderer, "remotion");
  assert.equal((await first.call("GET", "/api/publish/jobs")).json.data.jobs.length, 0, "a plan persists nothing");

  const created = await first.call("POST", "/api/publish/jobs", body(f.slug));
  assert.equal(created.json.data.state, "ready");
  const executed = await first.call("POST", `/api/publish/jobs/${created.json.data.jobId}/execute`);
  assert.equal(executed.status, 200);
  assert.equal(executed.json.data.state, "published");
  const receipt = executed.json.data.receipt;
  assert.equal(receipt.destination.id, "local-mock");
  assert.equal(receipt.destination.accountId, "local");
  assert.match(receipt.url, /^mock:\/\/local-mock\/mock-/);

  const again = await first.call("POST", `/api/publish/jobs/${created.json.data.jobId}/execute`);
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "PUBLISH_JOB_CONFLICT");

  // A separate server process-equivalent: state comes from disk.
  const second = await api(t);
  const history = await second.call("GET", `/api/publish/receipts?track=${f.slug}`);
  assert.equal(history.json.data.status, "complete");
  assert.deepEqual(history.json.data.receipts, [receipt]);
  assert.equal((await second.call("GET", `/api/publish/receipts?track=${f.slug}&renderer=after-effects`)).json.data.receipts.length, 0);
  const jobs = await second.call("GET", `/api/publish/jobs?track=${f.slug}`);
  assert.equal(jobs.json.data.jobs[0].state, "published");
  assert.deepEqual(jobs.json.data.jobs[0].receipt, receipt);
});

test("API: blocked requests say why — stale export, unsupported format, missing renderer, bad ids", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion", "vertical-9x16");
  const { call } = await api(t);

  const unsupported = await call("POST", "/api/publish/plan", body(f.slug, { destination: "local-mock-landscape", source: { track: f.slug, format: "vertical-9x16", renderer: "remotion" } }));
  assert.deepEqual(unsupported.json.data.problems.map((p: { reason: string }) => p.reason), ["format_unsupported"]);

  const reserved = await call("POST", "/api/publish/plan", body(f.slug, { destination: "youtube", source: { track: f.slug, format: "vertical-9x16", renderer: "remotion" } }));
  assert.deepEqual(reserved.json.data.problems.map((p: { reason: string }) => p.reason), ["destination_unavailable"]);

  const missing = await call("POST", "/api/publish/plan", body(f.slug));
  assert.deepEqual(missing.json.data.problems.map((p: { reason: string }) => p.reason), ["export_missing"]);

  await call("PATCH", `/api/tracks/${f.slug}/metadata`, { title: "Changed" });
  const stale = await call("POST", "/api/publish/plan", body(f.slug, { source: { track: f.slug, format: "vertical-9x16", renderer: "remotion" } }));
  assert.deepEqual(stale.json.data.problems.map((p: { reason: string }) => p.reason), ["export_stale"]);

  const noRenderer = await call("POST", "/api/publish/plan", body(f.slug, { source: { track: f.slug, format: "youtube-16x9" } }));
  assert.equal(noRenderer.status, 400);
  assert.match(noRenderer.json.error.message, /renderer is required/);
  assert.equal((await call("POST", "/api/publish/plan", body(f.slug, { source: { track: f.slug, format: "youtube-16x9", renderer: "final-cut" } }))).json.error.code, "INVALID_RENDERER");
  assert.equal((await call("POST", "/api/publish/plan", body(f.slug, { source: { track: f.slug, format: "4k", renderer: "remotion" } }))).json.error.code, "INVALID_PRESET");
  assert.equal((await call("POST", "/api/publish/plan", body("../etc"))).json.error.code, "INVALID_SLUG");
  assert.equal((await call("POST", "/api/publish/jobs", body(f.slug, { destination: "nope" }))).json.error.code, "PUBLISH_DESTINATION_UNKNOWN");
  assert.equal((await call("POST", "/api/publish/plan", { source: {} })).status, 400);
  assert.equal((await call("GET", "/api/publish/jobs/pub_ffffffffffffffffffffffff")).status, 404);
  assert.equal((await call("GET", "/api/publish/jobs/..%2f..%2fetc")).status, 404);
  assert.equal((await call("POST", "/api/publish/jobs/pub_ffffffffffffffffffffffff/execute")).status, 404);
  assert.equal((await call("GET", "/api/publish/receipts?limit=0")).status, 400);
});

test("API: a ready job can be cancelled; a cancelled job cannot be executed", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const { call } = await api(t);
  const created = await call("POST", "/api/publish/jobs", body(f.slug));
  const cancelled = await call("POST", `/api/publish/jobs/${created.json.data.jobId}/cancel`);
  assert.equal(cancelled.json.data.state, "cancelled");
  assert.equal((await call("POST", `/api/publish/jobs/${created.json.data.jobId}/execute`)).status, 409);
  assert.equal((await call("POST", `/api/publish/jobs/${created.json.data.jobId}/recover`)).status, 409);
});
