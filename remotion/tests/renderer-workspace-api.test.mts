import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { handleRequest } from "../server/app.ts";
import { registerRendererWorkspace } from "../services/render/rendererWorkspace.ts";
import type { WorkspaceInspection } from "../core/ports/rendererWorkspace.ts";
const inspection: WorkspaceInspection = {
  configured: true,
  problem: null,
  artifacts: [],
  activeJobs: 0,
  orphanedLocks: 0,
  abandonedPartials: 0,
  recoverable: 0,
  manual: 0,
  cacheEntries: 0,
  cacheBytes: 0,
  oldestCache: null,
  newestCache: null,
  policy: { maxEntries: 20 },
};
const calls: unknown[] = [];
registerRendererWorkspace({
  inspect: async () => inspection,
  maintain: async (options) => {
    calls.push(options);
    return {
      dryRun: options.dryRun,
      candidates: [],
      removed: [],
      failures: [],
      inspection,
    };
  },
});
const request = async (url: string, method = "GET", body?: unknown) => {
  const req = Object.assign(
    Readable.from(
      body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
    ),
    { url, method, headers: {} },
  );
  const res = {
    headersSent: false,
    status: 0,
    body: "",
    writeHead(status: number) {
      this.status = status;
      this.headersSent = true;
    },
    end(body: string) {
      this.body = body;
    },
  };
  await handleRequest(req as IncomingMessage, res as unknown as ServerResponse);
  return { status: res.status, body: JSON.parse(res.body) };
};
test("workspace API inspection is read-only and maintenance defaults to dry-run", async () => {
  calls.length = 0;
  const state = await request("/api/ae-workspace");
  assert.equal(state.status, 200);
  assert.deepEqual(state.body.data, inspection);
  assert.deepEqual(calls, []);
  await request("/api/ae-workspace/cleanup", "POST", {});
  assert.deepEqual(calls, [{ dryRun: true, prune: false }]);
  await request("/api/ae-workspace/cleanup", "POST", {
    dryRun: false,
    prune: true,
  });
  assert.deepEqual(calls.at(-1), { dryRun: false, prune: true });
});
test("workspace API rejects non-boolean deletion flags without invoking maintenance", async () => {
  calls.length = 0;
  for (const body of [{ dryRun: "false" }, { prune: 1 }, { dryRun: null }])
    assert.equal(
      (await request("/api/ae-workspace/cleanup", "POST", body)).status,
      400,
    );
  assert.deepEqual(calls, []);
});
