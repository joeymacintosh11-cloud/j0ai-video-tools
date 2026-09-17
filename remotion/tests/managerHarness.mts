import childProcess, { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { PassThrough } from "node:stream";
import type { TestContext } from "node:test";

/**
 * A stand-in for a forked render worker.
 *
 * Tests drive the lifecycle by emitting the events a real child would, which is
 * what makes it possible to cover spawn failures and odd event orderings
 * without spending three minutes on an actual render.
 */
export class Worker extends EventEmitter {
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

export type Manager =
  typeof import("../server/services/renderManager.ts").renderManager;

/**
 * A render manager with fork() replaced, on a fresh module instance.
 *
 * The manager is a module singleton, so each test imports it under a unique
 * query string to get its own queue rather than inheriting another test's.
 */
export const manager = async (
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

/** A manager whose workers all report a pid, i.e. spawned successfully. */
export const managerWithWorkers = async (
  t: TestContext,
): Promise<{ manager: Manager; workers: Worker[] }> => {
  const workers: Worker[] = [];
  const instance = await manager(t, () => {
    const worker = new Worker();
    worker.pid = workers.length + 100;
    workers.push(worker);
    return worker;
  });

  return { manager: instance, workers };
};

export const tick = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));
