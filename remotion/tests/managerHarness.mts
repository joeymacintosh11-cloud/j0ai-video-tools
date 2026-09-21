import childProcess, { type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
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
  send(_message?: unknown) {
    void _message;
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

  // renderManager journals every lifecycle transition (see
  // server/services/renderJournal.ts). Redirecting it to a throwaway temp
  // directory means these tests — which use a fake worker and never touch a
  // real render — never write into this repository's real
  // out/.render-journal/, and never race each other over a shared file.
  const journalDir = await mkdtemp(path.join(tmpdir(), "toshi-manager-test-journal-"));
  const previousJournalDir = process.env.TOSHI_RENDER_JOURNAL_DIR;
  process.env.TOSHI_RENDER_JOURNAL_DIR = journalDir;
  t.after(async () => {
    // renderManager fires journal writes without awaiting them (deliberately
    // — see server/services/renderJournal.ts), so one can still be mid-flight
    // when the test function itself returns. Waiting for the journal to go
    // idle *before* touching env or the directory is what makes this
    // deterministic: a fixed delay was tried first and was not reliable — an
    // in-flight write's own `mkdirSync(root, { recursive: true })` would
    // silently recreate the directory this was about to remove, once, right
    // after removal, with no error on either side.
    const { waitForRenderJournalIdle } = await import("../server/services/renderJournal.ts");
    await waitForRenderJournalIdle();
    if (previousJournalDir === undefined) delete process.env.TOSHI_RENDER_JOURNAL_DIR;
    else process.env.TOSHI_RENDER_JOURNAL_DIR = previousJournalDir;
    await rm(journalDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
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
