import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { handleRequest } from "../server/app.ts";

export const request = async (url: string) => {
  const req = Object.assign(Readable.from([]), {
    url,
    method: "GET",
    headers: {},
  });
  const response = {
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
  await handleRequest(
    req as IncomingMessage,
    response as unknown as ServerResponse,
  );
  return { status: response.status, body: JSON.parse(response.body) };
};

for (const url of ["//[", "/api/tracks/%", "/api/tracks/%E0%A4%A"]) {
  test(`malformed URL ${url} returns structured 400`, async () => {
    const result = await request(url);
    assert.equal(result.status, 400);
    assert.equal(result.body.error.code, "INVALID_REQUEST");
    assert.equal((await request("/api/health")).status, 200);
  });
}
