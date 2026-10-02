import childProcess, { type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";

/**
 * One half of the real cross-process restart probe (see
 * render-journal-restart.test.mts). This process plays "the API server
 * before it dies": it starts a render through the real `renderManager`
 * singleton, lets it reach a genuinely non-terminal state, records that
 * state actually landed in the journal, and then simply exits — never
 * cancelling or completing the job — exactly what a hard process kill does.
 * A `renderManager.getJob` in this same process is a *live* answer, which
 * the test also captures for comparison against what the next process (a
 * real restart, a fresh boot id) sees for the identical job id.
 *
 *   argv: <journal root> <track slug>
 *
 * The render worker itself is mocked (a real render is not the claim under
 * test — the claim is about a real OS process boundary), the same fake used
 * throughout tests/managerHarness.mts.
 */

class Worker extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid = 4242;
  send() {
    return true;
  }
  kill() {
    return true;
  }
}

const [root] = process.argv.slice(2);
const slug = process.argv[3];

process.env.TOSHI_RENDER_JOURNAL_DIR = root;

let worker: Worker | undefined;
childProcess.fork = (() => {
  worker = new Worker();
  return worker as unknown as ChildProcess;
}) as typeof childProcess.fork;
syncBuiltinESMExports();

const { renderManager } = await import("../services/workflows/renderManager.ts");
const { RENDER_MANAGER_BOOT_ID } = await import("../services/workflows/renderJournal.ts");

const job = renderManager.startRender(slug);
// Let the fake worker announce "rendering", exactly like a real one mid-way
// through, so the journal records a genuinely non-terminal state.
await new Promise((resolve) => setImmediate(resolve));
worker?.emit("message", { type: "status", status: "rendering" });
await new Promise((resolve) => setImmediate(resolve));

const live = renderManager.getJob(job.id);

// Give the fire-and-forget journal append a moment to actually land before
// this process exits — otherwise the crash this simulates would be *too*
// real (losing an event that a genuine crash after fsync would not lose).
await new Promise((resolve) => setTimeout(resolve, 100));

process.send?.({
  type: "started",
  jobId: job.id,
  bootId: RENDER_MANAGER_BOOT_ID,
  liveStatus: live.status,
});
