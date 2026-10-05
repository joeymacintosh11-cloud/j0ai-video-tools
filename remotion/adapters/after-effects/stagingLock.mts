import {
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  renameSync,
  lstatSync,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";

export type WorkspaceOwner = {
  schemaVersion: 2;
  token: string;
  pid: number;
  hostname: string;
  renderer: "after-effects";
  createdAt: string;
  phase: string;
  safeToDelete: boolean;
  trackIdentity: string | null;
  runToken: string | null;
  runDirectory: string | null;
  preparedProject: string | null;
  childPid: number | null;
};
export const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
};
export const readWorkspaceOwner = (file: string): WorkspaceOwner | null => {
  try {
    if (!lstatSync(file).isFile()) return null;
    const owner = JSON.parse(readFileSync(file, "utf8"));
    return owner.schemaVersion === 2 &&
      owner.renderer === "after-effects" &&
      typeof owner.token === "string" &&
      owner.token.length > 0 &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0 &&
      owner.pid <= 2147483647 &&
      typeof owner.hostname === "string" &&
      owner.hostname.length > 0 &&
      Number.isFinite(Date.parse(owner.createdAt)) &&
      typeof owner.phase === "string" &&
      typeof owner.safeToDelete === "boolean" &&
      ["trackIdentity", "runToken", "runDirectory", "preparedProject"].every(
        (k) => owner[k] === null || typeof owner[k] === "string",
      ) &&
      (owner.childPid === null ||
        (Number.isInteger(owner.childPid) && owner.childPid > 0))
      ? owner
      : null;
  } catch {
    return null;
  }
};
export const writeWorkspaceOwner = (
  file: string,
  owner: WorkspaceOwner,
): void => {
  const temporary = `${file}.tmp-${randomUUID()}`;
  writeFileSync(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
  try {
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
};
export const newWorkspaceOwner = (): WorkspaceOwner => ({
  schemaVersion: 2,
  token: randomUUID(),
  pid: process.pid,
  hostname: hostname(),
  renderer: "after-effects",
  createdAt: new Date().toISOString(),
  phase: "staging",
  safeToDelete: true,
  trackIdentity: null,
  runToken: null,
  runDirectory: null,
  preparedProject: null,
  childPid: null,
});

/** How long a held ownership guard is waited for before it counts as crashed. */
export const GUARD_WAIT_MS = 1_000;
const GUARD_POLL_MS = 5;
const GUARD_SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** Every ownership mutation uses the same exclusive guard. A crashed guard
 * stays manual: it can fence a half-finished ownership transition. */
export const withWorkspaceLockGuard = <T,>(
  folder: string,
  work: () => T,
): T => {
  const guard = `${folder}.guard`;
  // Guarded sections are a few synchronous file operations, so a held guard
  // is normally another process's momentary mutation (often a refused
  // acquire). Wait briefly for it, so that contention never fails a live
  // owner's update or release; a guard still held after that is treated as
  // crashed and stays manual.
  const deadline = Date.now() + GUARD_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(guard, { mode: 0o700 });
      break;
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== "EEXIST" ||
        Date.now() >= deadline
      )
        throw new TrackError(
          trackIssue(
            "RENDER_TARGET_LOCKED",
            `AE ownership mutation is locked at ${guard}; inspect before recovery.`,
          ),
        );
      Atomics.wait(GUARD_SLEEP, 0, 0, GUARD_POLL_MS);
    }
  }
  try {
    writeFileSync(
      path.join(guard, "owner.json"),
      JSON.stringify(newWorkspaceOwner()),
      { mode: 0o600 },
    );
    return work();
  } finally {
    rmSync(guard, { recursive: true, force: true });
  }
};
export type WorkspaceLock = (() => void) & {
  readonly folder: string;
  readonly token: string;
  readonly update: (
    changes: Partial<
      Pick<
        WorkspaceOwner,
        | "phase"
        | "safeToDelete"
        | "trackIdentity"
        | "runToken"
        | "runDirectory"
        | "preparedProject"
        | "childPid"
      >
    >,
  ) => void;
};

/** A dead Node owner alone never proves Adobe stopped. Legacy/malformed
 * metadata stays manual; recovery needs an explicit confirmed-safe phase. */
export const acquireAfterEffectsStagingLock = (
  dataFile: string,
  lockName:
    | ".toshi-ae-render.lock"
    | ".toshi-ae-workspace.lock" = ".toshi-ae-render.lock",
): WorkspaceLock => {
  const folder = path.join(realpathSync(path.dirname(dataFile)), lockName);
  let owner = newWorkspaceOwner();
  withWorkspaceLockGuard(folder, () => {
    try {
      mkdirSync(folder, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      throw new TrackError(
        trackIssue(
          "RENDER_TARGET_LOCKED",
          `After Effects staging is locked at ${folder}. AE renders run serially. ` +
            "Wait for the current render; after an interrupted render, verify aerender has stopped before removing this lock. Inspect with npm run ae-workspace.",
        ),
      );
    }
    try {
      writeFileSync(path.join(folder, "owner.json"), JSON.stringify(owner), {
        mode: 0o600,
      });
    } catch (error) {
      rmSync(folder, { recursive: true, force: true });
      throw error;
    }
  });
  const file = path.join(folder, "owner.json");
  let released = false;
  const release = (() => {
    if (released) return;
    withWorkspaceLockGuard(folder, () => {
      if (readWorkspaceOwner(file)?.token === owner.token)
        rmSync(folder, { recursive: true });
    });
    released = true;
  }) as WorkspaceLock;
  Object.assign(release, {
    folder,
    token: owner.token,
    update: (changes: Parameters<WorkspaceLock["update"]>[0]) => {
      if (released) throw new Error("AE lock already released.");
      withWorkspaceLockGuard(folder, () => {
        if (readWorkspaceOwner(file)?.token !== owner.token)
          throw new Error("AE lock ownership changed.");
        owner = { ...owner, ...changes };
        writeWorkspaceOwner(file, owner);
      });
    },
  });
  return release;
};
