import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { isolatePublishing, publishingTrack } from "./publishingHarness.mts";

/**
 * The publishing CLI (scripts/publish.mts) in a child process, against the
 * real destination registry (local mocks only) and an isolated publishing
 * root inherited through the environment.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);
const cli = async (args: readonly string[]) => {
  try {
    const { stdout, stderr } = await run(process.execPath, ["scripts/publish.mts", ...args], { cwd: PROJECT_ROOT, env: process.env });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, output: failed.stdout + failed.stderr };
  }
};

test("CLI: destinations, plan, publish and history", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");

  const destinations = await cli(["--destinations"]);
  assert.equal(destinations.code, 0, destinations.output);
  assert.match(destinations.output, /local-mock .*ready/);
  assert.match(destinations.output, /youtube .*unavailable/);

  const plan = await cli(["--plan", f.slug, "--destination", "local-mock"]);
  assert.equal(plan.code, 0, plan.output);
  assert.match(plan.output, /Remotion export → local-mock/);
  assert.match(plan.output, /Ready to publish\. Nothing was published/);
  assert.match((await cli(["--history"])).output, /No publications recorded/);

  const blocked = await cli(["--plan", f.slug, "--destination", "local-mock", "--renderer", "after-effects"]);
  assert.equal(blocked.code, 1);
  assert.match(blocked.output, /Export missing/);

  const unsupported = await cli(["--publish", f.slug, "--destination", "local-mock-landscape", "--format", "square-1x1"]);
  assert.equal(unsupported.code, 1);
  assert.match(unsupported.output, /failed[\s\S]*Format not supported/);

  const unknown = await cli(["--publish", f.slug, "--destination", "tiktokk"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /Unknown publishing destination "tiktokk"/);

  const published = await cli(["--publish", f.slug, "--destination", "local-mock", "--title", "CLI title", "--tag", "#cli"]);
  assert.equal(published.code, 0, published.output);
  assert.match(published.output, /published/);
  assert.match(published.output, /mock:\/\/local-mock\/mock-/);

  const history = await cli(["--history", "--track", f.slug, "--json"]);
  const view = JSON.parse(history.output);
  assert.equal(view.receipts.length, 1);
  assert.equal(view.receipts[0].metadata.title, "CLI title");
  assert.deepEqual(view.receipts[0].metadata.tags, ["cli"]);
  assert.equal(view.receipts[0].source.renderer, "remotion");
  const jobs = await cli(["--history", "--jobs", "--track", f.slug]);
  assert.match(jobs.output, /published/);
  assert.match(jobs.output, /failed/);
});
