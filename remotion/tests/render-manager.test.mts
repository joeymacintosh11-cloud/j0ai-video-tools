import assert from "node:assert/strict";
import test from "node:test";
import { manager, tick, Worker } from "./managerHarness.mts";

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

test("a second render of the same track is refused while one is in flight", async (t) => {
  const workers: Worker[] = [];
  const m = await manager(t, () => {
    const w = new Worker();
    w.pid = workers.length + 100;
    workers.push(w);
    return w;
  });
  const first = m.startRender("same-track");
  assert.throws(() => m.startRender("same-track"), {
    code: "RENDER_ALREADY_ACTIVE",
  });
  // A different track is unaffected, and queues behind the single slot.
  const other = m.startRender("other-track");
  assert.equal(m.getJob(other.id).status, "queued");

  // Once the first finishes, the same track may be rendered again.
  workers[0].emit("exit", 0, null);
  await tick();
  assert.equal(m.getJob(first.id).status, "failed");
  const again = m.startRender("same-track");
  assert.equal(m.getJob(again.id).status, "queued");
  for (const worker of workers) worker.emit("close", 1, null);
});

test("a queued duplicate is refused too, not just a running one", async (t) => {
  const workers: Worker[] = [];
  const m = await manager(t, () => {
    const w = new Worker();
    w.pid = workers.length + 100;
    workers.push(w);
    return w;
  });
  m.startRender("busy");
  const queued = m.startRender("waiting");
  assert.equal(m.getJob(queued.id).status, "queued");
  assert.throws(() => m.startRender("waiting"), {
    code: "RENDER_ALREADY_ACTIVE",
  });
  for (const worker of workers) worker.emit("close", 1, null);
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
