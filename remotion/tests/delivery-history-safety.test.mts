import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  closeSync,
  existsSync,
  openSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  DELIVERY_HISTORY_DEFAULT_LIMIT,
  DELIVERY_HISTORY_MAX_LIMIT,
  DELIVERY_LOG_FILENAME,
  DELIVERY_LOG_SCHEMA_VERSION,
  DELIVERY_LOG_STATUS_NOTES,
  parseDeliveryLog,
  selectDeliveryHistory,
  type DeliveryLogEvent,
} from "../core/domain/delivery/deliveryHistory.ts";
import {
  appendDeliveryLogEvent,
  deliveryLogPath,
  readDeliveryLog,
  releaseDeliveryLogLock,
  repairDeliveryLogTail,
} from "../services/delivery/deliveryHistoryLog.ts";

/**
 * Delivery history: the audit's regression tests.
 *
 * Kept apart from `delivery-history.test.mts` the way `lock-safety` is kept
 * apart from `render-lock`: those tests describe what the feature does, these
 * pin down the specific ways it was found to be wrong. Every one of them failed
 * before the fix it guards.
 *
 * Real directories, real forked processes and real failure injection, because
 * every claim here is about the filesystem or about two processes.
 */

const LOCK_FILENAME = ".delivery-log.lock";

const destination = async (t: TestContext) => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "toshi-history-safety-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const synthetic = (overrides: Partial<DeliveryLogEvent> = {}): DeliveryLogEvent => ({
  schemaVersion: DELIVERY_LOG_SCHEMA_VERSION,
  eventId: randomUUID(),
  kind: "delivery",
  source: "delivery",
  deliveredAt: "2026-09-18T14:22:09.000Z",
  track: {
    slug: "probe",
    title: "Probe Beat",
    artist: "Toshi",
    key: "F Minor",
    bpm: 100,
  },
  preset: {
    id: "youtube-16x9",
    label: "YouTube 16:9",
    width: 1920,
    height: 1080,
    fps: 30,
  },
  path: "Probe Beat/probe-youtube-16x9.mp4",
  bytes: 416_219,
  exportFingerprint: "a".repeat(64),
  deliveryId: randomUUID(),
  ...overrides,
});

const line = (event: DeliveryLogEvent): string => `${JSON.stringify(event)}\n`;

const logFile = (root: string): string => path.join(root, DELIVERY_LOG_FILENAME);

/** A live child that holds, repairs or appends on command. */
const contender = async (
  t: TestContext,
  root: string,
  mode: "hold" | "repair" | "append",
  marker = "m",
) => {
  const child = fork(
    new URL("./history-lock-process.mts", import.meta.url),
    [root, mode, marker],
    { stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  await once(child, "message");
  return child;
};

/**
 * Replaces FileHandle.prototype.write for one call.
 *
 * The prototype is not exported, so it is reached through a handle — which is
 * the only way to inject a short write, and a short write is the one thing
 * POSIX permits here that Node does not handle for us.
 */
const withPatchedHandle = async <T,>(
  root: string,
  patch: (original: (...args: never[]) => unknown) => (...args: never[]) => unknown,
  body: () => Promise<T>,
): Promise<T> => {
  const probe = await open(path.join(root, ".probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as Record<string, unknown>;
  await probe.close();

  const original = prototype.write as (...args: never[]) => unknown;
  prototype.write = patch(original);

  try {
    return await body();
  } finally {
    prototype.write = original;
    await rm(path.join(root, ".probe"), { force: true });
  }
};

/* ------------------------------------------------------------------ *
 * The critical one: appending onto an unterminated line
 * ------------------------------------------------------------------ */

test("appending to a log whose last line is unterminated loses nothing", async (t) => {
  const root = await destination(t);
  const first = synthetic();
  const second = synthetic();

  // A final line that is *complete JSON but not newline-terminated*. A
  // truncated write that stopped on the closing brace leaves this, and so does
  // an editor that strips the trailing newline. It parses, so it was reported
  // as a whole event and no problem was recorded — and the append then spliced
  // the new event onto it and destroyed both.
  await writeFile(logFile(root), `${line(first)}${JSON.stringify(second)}`, "utf8");

  const before = readDeliveryLog(root);
  assert.equal(before.status, "complete");
  assert.equal(before.endsWithNewline, false);
  assert.deepEqual(before.events.map((event) => event.eventId), [
    first.eventId,
    second.eventId,
  ]);

  const third = synthetic();
  const result = await appendDeliveryLogEvent(root, third);
  assert.equal(result.appended, true);

  const after = readDeliveryLog(root);
  assert.equal(after.status, "complete", JSON.stringify(after.problems));
  assert.deepEqual(after.events.map((event) => event.eventId), [
    first.eventId,
    second.eventId,
    third.eventId,
  ]);
  assert.equal(after.endsWithNewline, true);
});

test("the newline decision follows termination, not whether a problem was found", async (t) => {
  const root = await destination(t);
  const kept = synthetic();

  // Four shapes of "last line not terminated": a whole event, a truncated
  // object, garbage, and nothing at all. Every one of them must leave the
  // events before it intact once something is appended.
  for (const tail of ["", JSON.stringify(synthetic()), '{"schemaVersion":1,"ev', "!!!"]) {
    await writeFile(logFile(root), `${line(kept)}${tail}`, "utf8");

    const expected = readDeliveryLog(root).events.length;
    const added = synthetic();
    assert.equal((await appendDeliveryLogEvent(root, added)).appended, true, tail);

    const after = readDeliveryLog(root);
    assert.equal(
      after.events.some((event) => event.eventId === kept.eventId),
      true,
      `kept the earlier event with tail ${JSON.stringify(tail)}`,
    );
    assert.equal(
      after.events.some((event) => event.eventId === added.eventId),
      true,
      `kept the appended event with tail ${JSON.stringify(tail)}`,
    );
    assert.equal(after.events.length, expected + 1, tail);
  }
});

/* ------------------------------------------------------------------ *
 * Path safety
 * ------------------------------------------------------------------ */

test("a log or lock path that is a symlink is refused, not followed", async (t) => {
  const root = await destination(t);
  const elsewhere = await destination(t);
  const victim = path.join(elsewhere, "unrelated.txt");
  await writeFile(victim, "IMPORTANT UNRELATED FILE\n");

  // A bookkeeping file that is a link would have every write to it land
  // wherever it points — outside the destination, on top of something else.
  symlinkSync(victim, logFile(root));

  const result = await appendDeliveryLogEvent(root, synthetic());
  assert.equal(result.appended, false);
  assert.match(result.problem ?? "", /must be a regular file, not a link/);
  assert.equal(await readFile(victim, "utf8"), "IMPORTANT UNRELATED FILE\n");

  // Reading, repairing and resolving the path all refuse it too.
  assert.throws(() => readDeliveryLog(root), { code: "INVALID_REQUEST" });
  assert.throws(() => deliveryLogPath(root), { code: "INVALID_REQUEST" });

  const lockedRoot = await destination(t);
  symlinkSync(victim, path.join(lockedRoot, LOCK_FILENAME));
  const locked = await appendDeliveryLogEvent(lockedRoot, synthetic());
  assert.equal(locked.appended, false);
  assert.match(locked.problem ?? "", /must be a regular file, not a link/);
  assert.equal(await readFile(victim, "utf8"), "IMPORTANT UNRELATED FILE\n");
});

test("a directory where the log belongs is refused with something readable", async (t) => {
  const root = await destination(t);
  mkdirSync(logFile(root));

  for (const attempt of [
    appendDeliveryLogEvent(root, synthetic()),
    repairDeliveryLogTail(root),
  ]) {
    const result = await attempt.catch((error: Error) => ({ problem: error.message }));
    assert.match(
      (result as { problem: string | null }).problem ?? "",
      /must be a regular file/,
    );
  }
});

test("an append refuses a destination whose identity changed while it waited", async (t) => {
  const root = await destination(t);
  await appendDeliveryLogEvent(root, synthetic());

  // A holder keeps the lock, so the append is stuck in acquisition with its
  // captured identity — the window the re-check under the lock exists for.
  const holder = await contender(t, root, "hold");
  const moved = `${root}-moved`;

  const appending = appendDeliveryLogEvent(root, synthetic());

  // Same pathname, a different directory: a remount, or a hand-swap.
  renameSync(root, moved);
  t.after(() => rm(moved, { recursive: true, force: true }));
  mkdirSync(root);

  const released = once(holder, "message");
  holder.send("release");
  await released;

  const result = await appending;

  assert.equal(result.appended, false);
  assert.match(result.problem ?? "", /changed, so the delivery was not recorded/);
  // Neither the impostor nor the real destination was written to.
  assert.equal(existsSync(logFile(root)), false);
  assert.equal(readDeliveryLog(moved).events.length, 1);
});

/* ------------------------------------------------------------------ *
 * The append lock
 * ------------------------------------------------------------------ */

test("a lock is published whole or not at all, and never half-created", async (t) => {
  const root = await destination(t);
  let calls = 0;

  // Writing the metadata *into* an already-created lock file used to leave a
  // window where a failure published an empty, unreadable, unreclaimable lock.
  // It is staged and linked into place now, so a failed write leaves nothing.
  t.mock.method(fs, "writeSync", () => {
    calls += 1;
    throw new Error("disk full");
  });
  const { syncBuiltinESMExports } = await import("node:module");
  syncBuiltinESMExports();

  try {
    const result = await appendDeliveryLogEvent(root, synthetic());
    assert.equal(result.appended, false);
    assert.match(result.problem ?? "", /disk full/);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  assert.ok(calls > 0, "the injected failure was reached");
  // No lock, and no temp file either.
  assert.deepEqual(await readdir(root), []);

  // And the destination still works afterwards, which is the whole point.
  assert.equal((await appendDeliveryLogEvent(root, synthetic())).appended, true);
});

test("an unreadable lock blocks acquisition but can be cleared on request", async (t) => {
  const root = await destination(t);

  // What a kill in the old create-then-write window left behind. Acquisition
  // must not guess here — that is where ownership changes hands — so it fails
  // closed, and the operator path is what unsticks the destination.
  closeSync(openSync(path.join(root, LOCK_FILENAME), "wx"));

  const blocked = await appendDeliveryLogEvent(root, synthetic());
  assert.equal(blocked.appended, false);
  assert.match(blocked.problem ?? "", /locked by another process/);
  assert.match(blocked.problem ?? "", /--release-lock/);
  assert.equal(existsSync(path.join(root, LOCK_FILENAME)), true, "left for the operator");

  const released = await releaseDeliveryLogLock(root);
  assert.equal(released.released, true);
  assert.match(released.problem ?? "", /could not be read/);

  assert.equal((await appendDeliveryLogEvent(root, synthetic())).appended, true);
  assert.equal(readDeliveryLog(root).events.length, 1);
});

test("clearing a lock refuses a live local owner, a foreign host, and nothing at all", async (t) => {
  const root = await destination(t);
  const lock = path.join(root, LOCK_FILENAME);
  const write = (owner: Record<string, unknown>) =>
    writeFileSync(lock, JSON.stringify({ token: "t", createdAt: new Date().toISOString(), ...owner }));

  assert.deepEqual(await releaseDeliveryLogLock(root), {
    released: false,
    problem: "There is no delivery log lock to clear.",
  });

  // Unmistakably alive, so it must never be revoked.
  write({ pid: process.pid, hostname: hostname() });
  const live = await releaseDeliveryLogLock(root);
  assert.equal(live.released, false);
  assert.match(live.problem ?? "", new RegExp(`Process ${process.pid} .* still holds`));
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "t");

  // Another machine: this one cannot know, so it does not act.
  write({ pid: 2, hostname: "some-other-machine" });
  const foreign = await releaseDeliveryLogLock(root);
  assert.equal(foreign.released, false);
  assert.match(foreign.problem ?? "", /held by some-other-machine/);
  assert.equal(existsSync(lock), true);

  // Dead on this host is the one case it may clear.
  write({ pid: 2147483646, hostname: hostname() });
  assert.deepEqual(await releaseDeliveryLogLock(root), { released: true, problem: null });
  assert.equal(existsSync(lock), false);
});

test("a live holder is waited for and never stolen, and the wait is bounded", async (t) => {
  const root = await destination(t);
  const holder = await contender(t, root, "hold", "keeper");
  const lock = path.join(root, LOCK_FILENAME);

  const started = Date.now();
  const result = await appendDeliveryLogEvent(root, synthetic());
  const waited = Date.now() - started;

  assert.equal(result.appended, false);
  assert.match(result.problem ?? "", /locked by another process/);
  // Bounded: the caller is a delivery that has already succeeded.
  assert.ok(waited >= 4_500 && waited < 20_000, `waited ${waited}ms`);
  // The live owner's lock is intact — a stolen lock would admit two appenders.
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "held-keeper");
  assert.equal(readDeliveryLog(root).status, "missing");

  const released = once(holder, "message");
  holder.send("release");
  await released;

  assert.equal((await appendDeliveryLogEvent(root, synthetic())).appended, true);
});

test("an owner displaced while it worked never removes its successor's lock", async (t) => {
  const root = await destination(t);
  const lock = path.join(root, LOCK_FILENAME);

  // Mid-append, the lock is removed externally and a successor takes it. The
  // displaced owner finishes and must recognise that the lock is no longer its
  // own: releasing one someone else now holds would admit two appenders.
  await withPatchedHandle(
    root,
    (original) =>
      function patched(this: unknown, ...args: never[]) {
        writeFileSync(
          lock,
          JSON.stringify({
            pid: process.pid,
            hostname: hostname(),
            token: "successor",
            createdAt: new Date().toISOString(),
          }),
        );
        return (original as (...a: never[]) => unknown).apply(this, args);
      },
    () => appendDeliveryLogEvent(root, synthetic()),
  );

  assert.equal(existsSync(lock), true, "the successor's lock survived");
  assert.equal(JSON.parse(readFileSync(lock, "utf8")).token, "successor");

  // Clean up the planted lock the way an operator would.
  assert.equal((await releaseDeliveryLogLock(root)).released, false, "it is live");
});

/* ------------------------------------------------------------------ *
 * Durability of one line
 * ------------------------------------------------------------------ */

test("a short write is completed rather than leaving a half line", async (t) => {
  const root = await destination(t);
  let shortWrites = 0;

  // POSIX permits write() to write fewer bytes than asked and Node does not
  // loop, so an unchecked byte count silently truncates the line. Ten bytes at
  // a time is the same failure, made reliable.
  await withPatchedHandle(
    root,
    (original) =>
      function patched(this: unknown, ...args: never[]) {
        const [buffer, offset, length, ...rest] = args as unknown as [
          Buffer, number, number, ...unknown[],
        ];
        if (Buffer.isBuffer(buffer) && typeof length === "number" && length > 10) {
          shortWrites += 1;
          return (original as (...a: never[]) => unknown).apply(this, [
            buffer, offset, 10, ...rest,
          ] as unknown as never[]);
        }
        return (original as (...a: never[]) => unknown).apply(this, args);
      },
    async () => {
      assert.equal((await appendDeliveryLogEvent(root, synthetic())).appended, true);
    },
  );

  assert.ok(shortWrites > 5, `forced ${shortWrites} short writes`);

  const read = readDeliveryLog(root);
  assert.equal(read.status, "complete", JSON.stringify(read.problems));
  assert.equal(read.events.length, 1);
  assert.equal(read.endsWithNewline, true);
});

test("a write that makes no progress fails instead of looping forever", async (t) => {
  const root = await destination(t);

  const result = await withPatchedHandle(
    root,
    () =>
      function patched() {
        return Promise.resolve({ bytesWritten: 0, buffer: Buffer.alloc(0) });
      },
    () => appendDeliveryLogEvent(root, synthetic()),
  );

  assert.equal(result.appended, false);
  assert.match(result.problem ?? "", /stopped making progress/);
  // And the lock was still released, so the destination is not wedged.
  assert.equal(existsSync(path.join(root, LOCK_FILENAME)), false);
});

test("an event survives a close that fails after it was made durable", async (t) => {
  const root = await destination(t);
  const probe = await open(path.join(root, ".probe"), "w");
  const prototype = Object.getPrototypeOf(probe) as Record<string, unknown>;
  await probe.close();

  const originalClose = prototype.close as () => Promise<void>;
  let closes = 0;
  prototype.close = function patched(this: unknown) {
    closes += 1;
    return closes === 1
      ? Promise.reject(new Error("close failed"))
      : originalClose.call(this);
  };

  try {
    const result = await appendDeliveryLogEvent(root, synthetic());
    // The write and the fsync both succeeded, so the event *is* recorded.
    // Reporting "not recorded" would send the operator to reconcile something
    // that is already there.
    assert.equal(result.appended, true);
    assert.equal(result.problem, null);
  } finally {
    prototype.close = originalClose;
  }

  assert.equal(readDeliveryLog(root).events.length, 1);
});

/* ------------------------------------------------------------------ *
 * Repair, and racing with it
 * ------------------------------------------------------------------ */

test("repair reports rather than throws when there is no log", async (t) => {
  const root = await destination(t);
  const result = await repairDeliveryLogTail(root);

  assert.equal(result.repaired, false);
  assert.match(result.problem ?? "", /no delivery log at this destination yet/);
});

test("repair never drops a valid event, however often it is run", async (t) => {
  const root = await destination(t);
  const kept = [synthetic(), synthetic(), synthetic()];
  const fragment = '{"schemaVersion":1,"eventId":"hal';
  await writeFile(logFile(root), `${kept.map(line).join("")}${fragment}`, "utf8");

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await repairDeliveryLogTail(root);
    assert.equal(result.repaired, attempt === 0, `attempt ${attempt}`);

    const read = readDeliveryLog(root);
    assert.equal(read.status, "complete");
    assert.deepEqual(
      read.events.map((event) => event.eventId),
      kept.map((event) => event.eventId),
      `attempt ${attempt} kept every earlier event`,
    );
  }
});

test("a repair and an append in different processes cannot damage the log", async (t) => {
  const root = await destination(t);
  const kept = [synthetic(), synthetic()];
  await writeFile(
    logFile(root),
    `${kept.map(line).join("")}{"schemaVersion":1,"eventId":"cu`,
    "utf8",
  );

  const repairer = await contender(t, root, "repair", "r");
  const appender = await contender(t, root, "append", "raced-append");

  const replies = [once(repairer, "message"), once(appender, "message")];
  const exits = [once(repairer, "exit"), once(appender, "exit")];
  // Released together, so one genuinely meets the other's lock.
  repairer.send("go");
  appender.send("go");
  await Promise.all(replies);
  await Promise.all(exits);

  const read = readDeliveryLog(root);
  const text = await readFile(logFile(root), "utf8");

  // There are two correct outcomes here and the race decides which:
  //
  //  - the repairer went first, dropped the fragment, and the log is complete;
  //  - the appender went first, terminated the fragment so its own event could
  //    land whole, and the repairer then refused to touch a log reading corrupt.
  //
  // What must hold either way is the invariant: no valid event was lost, the
  // appended event is there, and the only unparseable text in the file is the
  // original fragment — never anything spliced together.
  assert.ok(
    read.status === "complete" || read.status === "corrupt",
    `unexpected status ${read.status}`,
  );
  for (const event of kept) {
    assert.equal(
      read.events.some((recorded) => recorded.eventId === event.eventId),
      true,
      `kept ${event.eventId}`,
    );
  }
  assert.equal(
    read.events.some((recorded) => recorded.deliveryId === "raced-append"),
    true,
    "the appended event landed",
  );
  for (const row of text.split("\n").filter((candidate) => candidate.length > 0)) {
    const parsed = parseDeliveryLog(`${row}\n`);
    assert.ok(
      parsed.status === "complete" || row === '{"schemaVersion":1,"eventId":"cu',
      `unexpected unparseable line: ${JSON.stringify(row)}`,
    );
  }
  assert.equal((await readdir(root)).includes(LOCK_FILENAME), false);
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes(".tmp")),
    [],
  );
});

/* ------------------------------------------------------------------ *
 * Duplicates
 * ------------------------------------------------------------------ */

test("a log holding the same event twice is not reported as healthy", async (t) => {
  const root = await destination(t);
  const repeated = synthetic();
  const other = synthetic();
  await writeFile(
    logFile(root),
    `${line(repeated)}${line(repeated)}${line(other)}`,
    "utf8",
  );

  const read = readDeliveryLog(root);

  // Nothing this tool writes can produce a repeat, so saying "complete" would
  // vouch for a log it has not actually checked.
  assert.equal(read.status, "duplicated");
  assert.equal(read.problems.length, 1);
  assert.equal(read.problems[0].kind, "duplicate");
  assert.match(read.problems[0].message, /repeats eventId/);
  assert.ok(DELIVERY_LOG_STATUS_NOTES.duplicated);
  // Every event is still returned: reporting it is not a reason to hide it.
  assert.equal(read.events.length, 3);

  // A repeated delivery id, with distinct event ids, is caught as well.
  const shared = synthetic({ deliveryId: "shared" });
  await writeFile(
    logFile(root),
    `${line(shared)}${line(synthetic({ deliveryId: "shared" }))}`,
    "utf8",
  );
  const delivery = readDeliveryLog(root);
  assert.equal(delivery.status, "duplicated");
  assert.match(delivery.problems[0].message, /repeats deliveryId/);

  // And appending still works, and still refuses the duplicate itself.
  assert.equal((await appendDeliveryLogEvent(root, shared)).duplicate, true);
  assert.equal((await appendDeliveryLogEvent(root, synthetic())).appended, true);
});

test("real damage outranks duplication in what a log is called", () => {
  const repeated = synthetic();
  const read = parseDeliveryLog(
    `${line(repeated)}not json at all\n${line(repeated)}`,
  );

  assert.equal(read.status, "corrupt");
  assert.deepEqual(
    read.problems.map((problem) => problem.kind).sort(),
    ["duplicate", "malformed"],
  );
});

test("two processes completing the same delivery record it once", async (t) => {
  const root = await destination(t);

  // Both are told the same deliveryId, which is what a retried completion step
  // looks like across processes. The duplicate scan and the write share one
  // lock, so exactly one of them can win.
  const children = await Promise.all([
    contender(t, root, "append", "one-delivery"),
    contender(t, root, "append", "one-delivery"),
  ]);
  const replies = children.map((child) => once(child, "message"));
  const exits = children.map((child) => once(child, "exit"));
  children.forEach((child) => child.send("go"));
  const results = (await Promise.all(replies)).map(
    ([message]) => (message as { result: { appended: boolean; duplicate: boolean } }).result,
  );
  await Promise.all(exits);

  assert.equal(results.filter((result) => result.appended).length, 1);
  assert.equal(results.filter((result) => result.duplicate).length, 1);

  const read = readDeliveryLog(root);
  assert.equal(read.status, "complete");
  assert.equal(read.events.length, 1);
});

/* ------------------------------------------------------------------ *
 * Query edges
 * ------------------------------------------------------------------ */

test("a nonsense limit falls back to the default rather than to nothing", () => {
  const events = Array.from({ length: 80 }, () => synthetic());

  // NaN used to produce slice(0, NaN) — an empty page alongside a non-zero
  // match count, which reads exactly like "nothing was ever delivered".
  // Infinity is deliberately treated the same way: a caller that reaches here
  // with one has a bug, and quietly serving the ceiling would hide it.
  for (const limit of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    const selection = selectDeliveryHistory(events, { limit });
    assert.equal(selection.events.length, DELIVERY_HISTORY_DEFAULT_LIMIT, String(limit));
    assert.equal(selection.matched, 80);
  }

  // Out-of-range values are clamped, never inverted.
  for (const [limit, expected] of [
    [0, 1],
    [-5, 1],
    [1.9, 1],
    [10_000, Math.min(80, DELIVERY_HISTORY_MAX_LIMIT)],
  ] as const) {
    assert.equal(selectDeliveryHistory(events, { limit }).events.length, expected, String(limit));
  }
});

test("a malformed date filter is ignored rather than matching nothing", () => {
  const events = [
    synthetic({ deliveredAt: "2026-09-10T09:00:00.000Z" }),
    synthetic({ deliveredAt: "2026-09-15T09:00:00.000Z" }),
  ];

  for (const filter of [{ from: "whenever" }, { to: "whenever" }, { from: "", to: "" }]) {
    assert.equal(selectDeliveryHistory(events, filter).matched, 2, JSON.stringify(filter));
  }

  // An offset timestamp means the same instant as its UTC equivalent.
  assert.equal(
    selectDeliveryHistory(events, { from: "2026-09-15T11:00:00+02:00" }).matched,
    1,
  );
  // `to` is exclusive, so an empty range really is empty.
  assert.equal(
    selectDeliveryHistory(events, {
      from: "2026-09-15T09:00:00.000Z",
      to: "2026-09-15T09:00:00.000Z",
    }).matched,
    0,
  );
});
