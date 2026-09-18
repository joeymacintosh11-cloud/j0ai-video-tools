import { randomInt, randomUUID } from "node:crypto";
import { closeSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { open } from "node:fs/promises";
import { hostname } from "node:os";
import {
  DELIVERY_LOG_FILENAME,
  DELIVERY_REPORT_FILENAME,
  parseDeliveryLog,
  renderDeliveryReport,
  type DeliveryLogEvent,
  type DeliveryLogRead,
  type DeliveryReportRange,
} from "../../src/domain/delivery/deliveryHistory.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
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
 *      interleave with another;
 *   4. `fsync`ed before the lock is released, so a recorded event has reached
 *      the disk before anything is told it was recorded.
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
      const descriptor = openSync(file, "wx");
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
      } finally {
        closeSync(descriptor);
      }
      held = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const waited = Date.now() - start;

      if (waited >= LOCK_TIMEOUT_MS) {
        throw new TrackError(
          trackIssue(
            "INVALID_REQUEST",
            `The delivery log at ${root} is locked by another process and did not ` +
              `free up within ${LOCK_TIMEOUT_MS / 1000}s.`,
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
      return { status: "missing", events: [], problems: [], lines: 0 };
    }
    throw error;
  }

  return parseDeliveryLog(text);
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

        const needsNewline = existing.problems.some(
          (problem) => problem.kind === "truncated",
        );

        // One write of one complete line to an O_APPEND descriptor, then fsync:
        // the event is whole on disk before this returns, or it is absent.
        //
        // The leading newline matters. A hard crash can leave the log ending in
        // an incomplete line, and appending straight onto that would splice the
        // new event onto the fragment and lose it. Terminating the fragment
        // first means the new event always lands whole on a line of its own —
        // at the cost of the fragment becoming a mid-file malformed line, which
        // is reported as corruption rather than quietly tidied away. Repairing
        // the tail (see repairDeliveryLogTail) is the operator's call.
        const handle = await open(file, "a");
        try {
          await handle.write(`${needsNewline ? "\n" : ""}${JSON.stringify(event)}\n`);
          await handle.sync();
        } finally {
          await handle.close();
        }

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
      const text = readFileSync(file, "utf8");
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
