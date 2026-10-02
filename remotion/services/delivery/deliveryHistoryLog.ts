import { randomInt, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  linkSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import {
  DELIVERY_LOG_FILENAME,
  DELIVERY_REPORT_FILENAME,
  parseDeliveryLog,
  renderDeliveryReport,
  type DeliveryLogEvent,
  type DeliveryLogRead,
  type DeliveryReportRange,
} from "../../core/domain/delivery/deliveryHistory.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { withFileMutation, writeAtomicFile } from "../tracks/atomicFile.ts";
import {
  assertDeliveryRootFile,
  directoryIdentity,
} from "./deliveryDestination.ts";

/**
 * Reads and appends the destination's delivery log.
 *
 *   <export destination>/delivery-log.jsonl
 *
 * **Why JSON Lines.** Appending one line is a single write with no read of what
 * came before, so a growing history never has to be rewritten and an append can
 * never rewrite an earlier event even by accident — which is exactly the
 * property an append-only record needs. It also means a crash can damage at
 * most the final line, it can be read by anything, and it can be streamed if
 * this ever outgrows a single read. A single JSON array would fail every one of
 * those: each append would be a full rewrite of the whole history.
 *
 * **Why both a lock and O_APPEND.** POSIX says a write to a descriptor opened
 * with `O_APPEND` seeks to the end and writes with no intervening modification,
 * and in practice a sub-block write to a local filesystem does land whole. But
 * "in practice" is not a guarantee this file is willing to rest an audit record
 * on, so appends are also serialized by a lock at the destination:
 *
 *   1. serialized within this process by `withFileMutation`;
 *   2. serialized across processes by exclusive creation of
 *      `.delivery-log.lock` at the destination root;
 *   3. written as one `write()` of one complete line to an `O_APPEND`
 *      descriptor, so even an append that somehow bypassed the lock could not
 *      interleave with another. POSIX permits a short write, and Node does not
 *      loop, so the byte count is checked and the remainder written — still
 *      under the lock, so the continuation lands immediately after its own
 *      prefix and the line is whole;
 *   4. `fsync`ed before the lock is released — the file's data and its size,
 *      and the containing directory as well on the append that creates the
 *      file, so a recorded event has reached the disk before anything is told
 *      it was recorded.
 *
 * What is *not* claimed: that a crash cannot lose the event being written. It
 * can, right up until the fsync returns, and that is why the reader treats an
 * unterminated final line as recoverable rather than as damage.
 *
 * The lock is per destination root, so two different destinations never block
 * each other and nothing global is ever taken. It is held for one small write,
 * not for a copy.
 *
 * **Failing to append never fails a delivery.** The copy is already published
 * and its receipt is already committed; a log that could not be written is a
 * reportable problem, not a reason to disown a file that is sitting at the
 * destination. Every caller here gets a result rather than an exception.
 */

const LOCK_FILENAME = ".delivery-log.lock";

/** Long enough for any small write to finish, short enough to give up on. */
const LOCK_TIMEOUT_MS = 5_000;
/** Jittered, so several contenders do not retry in lockstep. */
const LOCK_RETRY_MS = 8;
const LOCK_RETRY_JITTER_MS = 12;
/** Only after this long is a lock considered worth checking for an owner. */
const LOCK_SUSPECT_MS = 250;

type LockOwner = {
  readonly pid: number;
  readonly hostname: string;
  readonly token: string;
  readonly createdAt: string;
};

export const deliveryLogPath = (root: string): string =>
  assertDeliveryRootFile(root, DELIVERY_LOG_FILENAME);

const lockPath = (root: string): string =>
  assertDeliveryRootFile(root, LOCK_FILENAME);

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

/**
 * Drops a lock whose owner is gone.
 *
 * One-sided on purpose, exactly as the render lock is: only a dead process *on
 * this host* permits reclaiming. A lock from another machine, or one whose
 * contents cannot be read, is left alone — a stuck log lock costs a warning on
 * a delivery that has already succeeded, whereas a wrongly stolen one would
 * admit two appenders.
 */
const clearAbandoned = (file: string): boolean => {
  const owner = readOwner(file);

  if (owner === null || owner.hostname !== hostname() || isAlive(owner.pid)) {
    return false;
  }

  try {
    // Re-read: if the token changed, someone legitimate took it meanwhile.
    if (readOwner(file)?.token !== owner.token) return false;
    unlinkSync(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * Publishes the lock complete, or not at all.
 *
 * The metadata is written to a private temp file and `fsync`ed, then `link`ed
 * into place — which fails with EEXIST if someone already holds the lock, so it
 * is still the exclusive-creation primitive. Writing *into* the lock file after
 * creating it, as this used to, left a window in which being killed published
 * an empty lock: unreadable, therefore never reclaimable, therefore a
 * destination whose history could never be appended to again. There is no such
 * window now, so "unreadable" means real corruption and is treated as such.
 */
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
    // Never leaves its own temp file behind, on any path.
    try {
      unlinkSync(temporary);
    } catch {
      // Never created, or already gone.
    }
  }
};

export type ReleaseDeliveryLogLockResult = {
  readonly released: boolean;
  readonly problem: string | null;
};

/**
 * Clears the append lock when asked to, and only then.
 *
 * Acquisition never clears an unreadable lock: that is the one place ownership
 * changes hands, and guessing there is what would admit two appenders. But a
 * lock nothing can explain would otherwise stop this destination's history
 * being recorded forever, so there is an operator path — the same shape as
 * `releaseRenderTargetLock`. It refuses a lock a live local process holds, and
 * refuses one from another host, where it cannot know.
 */
export const releaseDeliveryLogLock = async (
  root: string,
): Promise<ReleaseDeliveryLogLockResult> => {
  const file = lockPath(root);

  return withFileMutation(file, async () => {
    const owner = readOwner(file);

    if (owner === null) {
      try {
        unlinkSync(file);
        return {
          released: true,
          problem:
            "The lock could not be read, so it was cleared. Nothing can have been holding it.",
        };
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ENOENT"
          ? { released: false, problem: "There is no delivery log lock to clear." }
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
      // Re-read, so a lock legitimately taken since is never removed.
      if (readOwner(file)?.token !== owner.token) {
        return { released: false, problem: "The lock changed hands; nothing was cleared." };
      }
      unlinkSync(file);
      return { released: true, problem: null };
    } catch (error) {
      return { released: false, problem: (error as Error).message };
    }
  });
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs `operation` while holding the destination's append lock.
 *
 * Bounded: a lock nothing can explain is given up on rather than waited for
 * forever, because the caller is a finished delivery that must return.
 */
const withAppendLock = async <T>(
  root: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const file = lockPath(root);
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
        throw new TrackError(
          trackIssue(
            "INVALID_REQUEST",
            `The delivery log at ${root} is locked by another process and did not ` +
              `free up within ${LOCK_TIMEOUT_MS / 1000}s. If nothing is running, ` +
              `clear it with: npm run delivery-history -- --release-lock`,
          ),
        );
      }

      // Only worth inspecting once a lock has outlived any plausible write.
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

/**
 * The whole log, parsed.
 *
 * Reads the file in one go, which is right for a log of this size — a year of
 * daily deliveries is tens of kilobytes. It is encapsulated here precisely so
 * that a streaming reader can replace it without any caller changing: callers
 * get events and a status, never a file handle.
 */
export const readDeliveryLog = (root: string): DeliveryLogRead => {
  const file = deliveryLogPath(root);

  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "missing",
        events: [],
        problems: [],
        lines: 0,
        endsWithNewline: true,
      };
    }
    throw error;
  }

  return parseDeliveryLog(text);
};

/**
 * Writes one complete line to the end of the log, durably.
 *
 * `O_NOFOLLOW` so a symlink swapped in where the log belongs is refused rather
 * than followed out of the destination; `O_APPEND` so the write goes to the end
 * whatever else has happened to the file.
 *
 * POSIX allows `write()` to write fewer bytes than asked, and Node does not
 * loop, so the count is checked. Continuing is safe and correct here precisely
 * because the append lock is held: nothing else can write between the prefix
 * and its remainder, so the two land adjacent and the line is whole. A write
 * that makes no progress at all is a failure rather than an infinite loop.
 */
const appendLine = async (file: string, line: string): Promise<void> => {
  const bytes = Buffer.from(line, "utf8");
  // Node accepts a numeric flag set, which is the only way to ask for
  // O_NOFOLLOW. O_NOFOLLOW is POSIX; fall back to plain append if absent.
  const flags =
    constants.O_WRONLY |
    constants.O_CREAT |
    constants.O_APPEND |
    (constants.O_NOFOLLOW ?? 0);
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
    // Best effort, and after the sync: the event is already durable by this
    // point, so a close that fails must not be reported as "not recorded".
    try {
      await handle.close();
    } catch {
      // The descriptor is going away with this operation regardless.
    }
  }

  // fsync on the file makes its data and size durable, but not the directory
  // entry that first named it. Without this, the very first append to a
  // destination could be reported as recorded and then vanish entirely.
  if (created) {
    const directory = await open(path.dirname(file), constants.O_RDONLY);
    try {
      await directory.sync();
    } catch {
      // Not every filesystem allows fsync on a directory; the file's own sync
      // has already happened either way.
    } finally {
      await directory.close().catch(() => undefined);
    }
  }
};

export type AppendDeliveryLogResult = {
  readonly appended: boolean;
  /** Set when the event was already in the log, so nothing was written. */
  readonly duplicate: boolean;
  readonly problem: string | null;
};

/**
 * Appends one event, unless an event for the same completed delivery is there.
 *
 * The duplicate check reads the log under the same lock that the append is made
 * under, so a retried completion step cannot record the same delivery twice.
 * It compares `deliveryId`, which is derived from the receipt — a genuine
 * re-delivery writes a new receipt and therefore is not a duplicate.
 *
 * Reports rather than throws: a delivery that has already published its file
 * and committed its receipt must not be turned into a failure by its own
 * bookkeeping.
 */
export const appendDeliveryLogEvent = async (
  root: string,
  event: DeliveryLogEvent,
): Promise<AppendDeliveryLogResult> => {
  try {
    const identity = directoryIdentity(root);
    const file = deliveryLogPath(root);

    return await withFileMutation(file, () =>
      withAppendLock(root, async () => {
        // The destination may have been unmounted or swapped while the copy was
        // being made; an event must not be written into whatever is there now.
        if (directoryIdentity(root) !== identity) {
          return {
            appended: false,
            duplicate: false,
            problem: `The export destination ${root} changed, so the delivery was not recorded in the log.`,
          };
        }

        const existing = readDeliveryLog(root);

        if (
          existing.events.some(
            (recorded) => recorded.deliveryId === event.deliveryId,
          )
        ) {
          return { appended: false, duplicate: true, problem: null };
        }

        // The leading newline matters, and it is decided by whether the file
        // is *terminated* — not by whether a problem was found. A final line
        // can be unterminated and still parse perfectly well (a short write
        // that stopped on the closing brace, or an editor that stripped the
        // newline), and appending straight onto one spliced the new event onto
        // it and destroyed both. Terminating first means the new event always
        // lands whole on a line of its own.
        const needsNewline = !existing.endsWithNewline;
        const line = `${needsNewline ? "\n" : ""}${JSON.stringify(event)}\n`;

        await appendLine(file, line);

        return { appended: true, duplicate: false, problem: null };
      }),
    );
  } catch (error) {
    return {
      appended: false,
      duplicate: false,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
};

export type RepairDeliveryLogResult = {
  readonly repaired: boolean;
  /** The bytes dropped, so an operator can see what was lost. */
  readonly discarded: string | null;
  readonly problem: string | null;
};

/**
 * Drops an incomplete final line, and nothing else.
 *
 * Only ever run when asked for. It refuses unless the log reads as
 * `recovered_tail`, so it can only ever remove bytes that were already
 * unparseable — a partial append, not an event. Damage anywhere else is left
 * exactly as it is for someone to look at; silently rewriting an audit log to
 * make it parse is the one thing this must never do.
 *
 * Held under the append lock, because it replaces the file: an appender holding
 * the old inode would otherwise write into an orphan and lose its event.
 */
export const repairDeliveryLogTail = async (
  root: string,
): Promise<RepairDeliveryLogResult> => {
  const file = deliveryLogPath(root);

  return withFileMutation(file, () =>
    withAppendLock(root, async () => {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        // A destination with no history yet is not an error to repair; every
        // other read failure is reported as itself rather than as a throw,
        // because this runs from a CLI that should say what is wrong.
        return {
          repaired: false,
          discarded: null,
          problem:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "There is no delivery log at this destination yet, so there is nothing to repair."
              : `The delivery log could not be read: ${(error as Error).message}`,
        };
      }

      const read = parseDeliveryLog(text);

      if (read.status !== "recovered_tail") {
        return {
          repaired: false,
          discarded: null,
          problem:
            read.status === "complete" || read.status === "missing"
              ? "The delivery log has no incomplete final line, so there is nothing to repair."
              : `The delivery log reads as "${read.status}", which this repair deliberately will not touch. Inspect ${file} first.`,
        };
      }

      const lastNewline = text.lastIndexOf("\n");
      const keep = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
      const discarded = text.slice(lastNewline + 1);

      await writeAtomicFile(file, (handle) => handle.writeFile(keep, "utf-8"));

      return { repaired: true, discarded, problem: null };
    }),
  );
};

/**
 * Writes a human-readable report of a range of history to the destination.
 *
 * A *view* of the log, never a second copy of it: it is regenerated in full
 * each time and nothing ever reads it back. Published atomically, so a reader
 * of that folder never sees half a report, and only ever when asked for.
 */
export const writeDeliveryReport = async (
  root: string,
  events: readonly DeliveryLogEvent[],
  range: DeliveryReportRange,
  generatedAt: string = new Date().toISOString(),
): Promise<string> => {
  const file = assertDeliveryRootFile(root, DELIVERY_REPORT_FILENAME);
  const identity = directoryIdentity(root);

  return withFileMutation(file, async () => {
    if (directoryIdentity(root) !== identity) {
      throw new TrackError(
        trackIssue(
          "INVALID_REQUEST",
          `The export destination ${root} changed while the report was being written.`,
        ),
      );
    }

    await writeAtomicFile(file, (handle) =>
      handle.writeFile(renderDeliveryReport(events, range, generatedAt), "utf-8"),
    );

    return DELIVERY_REPORT_FILENAME;
  });
};
