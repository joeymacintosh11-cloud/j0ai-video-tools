import assert from "node:assert/strict";
import childProcess, { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import test, { type TestContext } from "node:test";

class Worker extends EventEmitter {
  stdout = new PassThrough();
  stderr = new PassThrough();
  pid: number | undefined;
  send() {
    return true;
  }
  kill() {
    return true;
  }
}
type Manager =
  typeof import("../server/services/renderManager.ts").renderManager;
const manager = async (
  t: TestContext,
  spawn: () => Worker,
): Promise<Manager> => {
  t.mock.method(
    childProcess,
    "fork",
    (() => spawn() as unknown as ChildProcess) as typeof childProcess.fork,
  );
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const module = (await import(
    new URL(
      `../server/services/renderManager.ts?test=${randomUUID()}`,
      import.meta.url,
    ).href
  )) as { renderManager: Manager };
  return module.renderManager;
};
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("spawn error without exit releases the slot and drains the queue once", async (t) => {
  const workers: Worker[] = [];
  const m = await manager(t, () => {
    const w = new Worker();
    workers.push(w);
    return w;
  });
  const first = m.startRender("first");
  const second = m.startRender("second");
  const third = m.startRender("third");
  workers[0].emit("error", new Error("spawn failed"));
  workers[0].emit("close", -2, null);
  await tick();
  assert.equal(m.getJob(first.id).status, "failed");
  assert.equal(m.getJob(second.id).status, "preparing");
  workers[0].emit("exit", -2, null);
  await tick();
  assert.equal(m.getJob(third.id).status, "queued");
  workers[1].emit("exit", 1, null);
  await tick();
  assert.equal(m.getJob(third.id).status, "preparing");
  workers[2].emit("close", 1, null);
});

test("synchronous fork failure returns a failed job and allows the next start", async (t) => {
  const worker = new Worker();
  let calls = 0;
  const m = await manager(t, () => {
    if (++calls === 1) throw new Error("fork failed");
    return worker;
  });
  const first = m.startRender("first");
  assert.equal(first.status, "failed");
  const second = m.startRender("second");
  assert.equal(second.status, "preparing");
  worker.emit("close", 1, null);
});

test("a running child's error does not release its slot before process termination", async (t) => {
  const workers: Worker[] = [];
  const m = await manager(t, () => {
    const w = new Worker();
    w.pid = workers.length + 100;
    workers.push(w);
    return w;
  });
  const first = m.startRender("first");
  const second = m.startRender("second");
  workers[0].emit("error", new Error("IPC error"));
  await tick();
  assert.equal(m.getJob(second.id).status, "queued");
  workers[0].emit("close", 1, null);
  await tick();
  assert.equal(m.getJob(first.id).status, "failed");
  assert.equal(m.getJob(second.id).status, "preparing");
  workers[1].emit("exit", 1, null);
});

test("completion remains completed; duplicate and late worker events cannot reopen a job", async (t) => {
  const worker = new Worker();
  const m = await manager(t, () => worker);
  const job = m.startRender("first");
  let terminalEvents = 0;
  m.subscribe(job.id, (event) => {
    if (event.type === "completed") terminalEvents++;
  });
  worker.emit("message", {
    type: "done",
    outputPath: "/unused",
    outputLabel: "out/first.mp4",
  });
  worker.emit("exit", 0, null);
  worker.emit("close", 0, null);
  worker.emit("message", { type: "status", status: "rendering" });
  worker.emit("error", new Error("late error"));
  await tick();
  assert.equal(m.getJob(job.id).status, "completed");
  assert.equal(m.getJob(job.id).error, null);
  assert.equal(terminalEvents, 1);
});

test("cancelled workers release the slot once without affecting the next worker", async (t) => {
  const workers: Worker[] = [];
  const m = await manager(t, () => {
    const w = new Worker();
    w.pid = workers.length + 100;
    workers.push(w);
    return w;
  });
  const first = m.startRender("first");
  const second = m.startRender("second");
  m.cancelRender(first.id);
  workers[0].emit("exit", null, "SIGTERM");
  await tick();
  assert.equal(m.getJob(first.id).status, "cancelled");
  assert.equal(m.getJob(second.id).status, "preparing");
  workers[0].emit("close", null, "SIGTERM");
  await tick();
  workers[1].emit("close", 1, null);
});
