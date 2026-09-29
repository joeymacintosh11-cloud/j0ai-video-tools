import { randomInt, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";

/**
 * Cross-process append primitives for a project-local JSON Lines log.
 *
 * Extracted verbatim from services/render/renderJournalLog.ts so that a second
 * project-local log (the content library) reuses the same lock and the same
 * durable append instead of carrying a third private copy of them. The
 * reasoning is unchanged and lives in services/delivery/deliveryHistoryLog.ts:
 * JSON Lines so a crash can damage at most one line; an exclusive
 * cross-process lock plus `O_APPEND` plus `fsync` so a reported append is
 * durable before anything is told so.
 *
 * The delivery log keeps its own copy on purpose: it lives at an export
 * destination rather than inside the project, and wraps every step in
 * destination-identity checks that do not apply here.
 */

const LOCK_TIMEOUT_MS = 5_000;
const LOCK_RETRY_MS = 8;
const LOCK_RETRY_JITTER_MS = 12;
const LOCK_SUSPECT_MS = 250;

type LockOwner = {
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
  readonly createdAt: string;
};

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else, which is still alive.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

const readOwner = (file: string): LockOwner | null => {
  try {
    const owner = JSON.parse(readFileSync(file, "utf8")) as LockOwner;
    return typeof owner?.token === "string" &&
      typeof owner.hostname === "string" &&
      Number.isInteger(owner.pid) &&
      owner.pid > 0
      ? owner
      : null;
  } catch {
    return null;
  }
};

/** Only a dead process on this host permits reclaiming; see deliveryHistoryLog.ts's twin. */
const clearAbandoned = (file: string): boolean => {
  const owner = readOwner(file);
  if (owner === null || owner.hostname !== hostname() || isAlive(owner.pid)) return false;
  try {
    if (readOwner(file)?.token !== owner.token) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
};

/** Publishes the lock complete or not at all: temp file, fsync, then link (EEXIST if held). */
const publishLock = (file: string, token: string): void => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const descriptor = openSync(temporary, "wx");
    try {
      writeSync(
        descriptor,
        JSON.stringify({
          pid: process.pid,
          hostname: hostname(),
          token,
          createdAt: new Date().toISOString(),
        } satisfies LockOwner),
      );
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    linkSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // Never created, or already gone.
    }
  }
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type JsonlAppendLockOptions = {
  /** Directory holding the log; created if absent. */
  readonly root: string;
  /** Lock file name inside `root`. */
  readonly lockFilename: string;
  /** How the log is named in a timeout message, e.g. "render journal". */
  readonly label: string;
  /** Appended to a timeout message, e.g. how to clear a stuck lock. */
  readonly hint?: string;
};

/**
 * Runs `operation` while holding the log's cross-process append lock.
 *
 * Bounded: a lock nothing can explain is given up on rather than waited for
 * forever, because every caller is a finished operation that must return.
 */
export const withJsonlAppendLock = async <T>(
  { root, lockFilename, label, hint }: JsonlAppendLockOptions,
  operation: () => Promise<T>,
): Promise<T> => {
  mkdirSync(root, { recursive: true });
  const file = path.join(root, lockFilename);
  const token = randomUUID();
  const start = Date.now();
  let held = false;

  while (!held) {
    try {
      publishLock(file, token);
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const waited = Date.now() - start;
      if (waited >= LOCK_TIMEOUT_MS) {
        throw new Error(
          `The ${label} at ${root} is locked by another process and did not free up ` +
            `within ${LOCK_TIMEOUT_MS / 1000}s.${hint ? ` ${hint}` : ""}`,
        );
      }
      if (waited > LOCK_SUSPECT_MS) clearAbandoned(file);
      await sleep(LOCK_RETRY_MS + randomInt(LOCK_RETRY_JITTER_MS));
    }
  }

  try {
    return await operation();
  } finally {
    // Best effort, and only our own: releasing a lock someone else now holds
    // would be worse than leaving this one behind.
    try {
      if (readOwner(file)?.token === token) unlinkSync(file);
    } catch {
      // Already gone, or not ours to remove.
    }
  }
};

export type ReleaseJsonlLockResult = {
  readonly released: boolean;
  readonly problem: string | null;
};

/**
 * Clears an append lock when an operator asks to, and only then.
 *
 * Same rules as `releaseDeliveryLogLock`: refuses a lock a live local process
 * holds, refuses one from another host (it cannot know), and clears an
 * unreadable one — which nothing can be holding, since a lock is only ever
 * published complete.
 */
export const releaseJsonlLock = (
  root: string,
  lockFilename: string,
  label: string,
): ReleaseJsonlLockResult => {
  const file = path.join(root, lockFilename);
  const owner = readOwner(file);

  if (owner === null) {
    try {
      unlinkSync(file);
      return {
        released: true,
        problem: "The lock could not be read, so it was cleared. Nothing can have been holding it.",
      };
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ENOENT"
        ? { released: false, problem: `There is no ${label} lock to clear.` }
        : { released: false, problem: (error as Error).message };
    }
  }

  if (owner.hostname !== hostname()) {
    return {
      released: false,
      problem: `The lock is held by ${owner.hostname}, so this machine cannot tell whether it is still alive. Clear it from there.`,
    };
  }

  if (isAlive(owner.pid)) {
    return {
      released: false,
      problem: `Process ${owner.pid} on this machine still holds the lock. Wait for it, or stop it first.`,
    };
  }

  try {
    if (readOwner(file)?.token !== owner.token) {
      return { released: false, problem: "The lock changed hands; nothing was cleared." };
    }
    unlinkSync(file);
    return { released: true, problem: null };
  } catch (error) {
    return { released: false, problem: (error as Error).message };
  }
};

/** The file's text, or null when it does not exist yet. Any other read failure throws. */
export const readTextIfPresent = (file: string): string | null => {
  try {
    return readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
};

/**
 * Writes one complete line to the end of a log, durably.
 *
 * `O_NOFOLLOW` so a symlink swapped in where the log belongs is refused;
 * `O_APPEND` so the write goes to the end whatever else happened. A short
 * write is continued — safe because the caller holds the append lock, so the
 * remainder lands immediately after its own prefix. The containing directory
 * is fsynced on the append that creates the file, so the first event cannot
 * vanish with an unsynced directory entry.
 */
export const appendJsonlLine = async (file: string, line: string): Promise<void> => {
  const bytes = Buffer.from(line, "utf8");
  const flags =
    constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0);
  const created = !existsSync(file);
  const handle = await open(file, flags, 0o644);

  try {
    let written = 0;
    while (written < bytes.length) {
      const result = await handle.write(bytes, written, bytes.length - written);
      if (result.bytesWritten <= 0) {
        throw new Error(
          `Wrote only ${written} of ${bytes.length} bytes to ${file} and then stopped making progress.`,
        );
      }
      written += result.bytesWritten;
    }
    await handle.sync();
  } finally {
    try {
      await handle.close();
    } catch {
      // The descriptor is going away with this operation regardless.
    }
  }

  if (created) {
    const directory = await open(path.dirname(file), constants.O_RDONLY);
    try {
      await directory.sync();
    } catch {
      // Not every filesystem allows fsync on a directory.
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
};
