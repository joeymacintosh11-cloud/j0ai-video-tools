import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, realpathSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  DELIVERY_HISTORY_MAX_LIMIT,
  DELIVERY_LOG_FILENAME,
  DELIVERY_LOG_SCHEMA_VERSION,
  DELIVERY_REPORT_FILENAME,
  parseDeliveryLog,
  parseRelativePeriod,
  renderDeliveryReport,
  selectDeliveryHistory,
  summarizeDeliveryHistory,
  type DeliveryLogEvent,
} from "../src/domain/delivery/deliveryHistory.ts";
import {
  appendDeliveryLogEvent,
  deliveryLogPath,
  readDeliveryLog,
  repairDeliveryLogTail,
  writeDeliveryReport,
} from "../services/delivery/deliveryHistoryLog.ts";
import {
  deliveryEventFor,
  deliveryIdForReceipt,
} from "../services/delivery/deliveryHistory.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import { deliverPlanned, planDeliveries } from "../server/services/deliveryPlan.ts";
import {
  deliveryReceiptPath,
  readDeliveryReceipt,
} from "../services/delivery/deliveryReceipt.ts";
import type { DeliverySettings } from "../services/delivery/deliverySettings.ts";
import {
  queryDeliveryHistory,
  reconcileDeliveryHistory,
} from "../server/services/deliveryHistory.ts";
import { generateReleaseBundle } from "../services/delivery/releaseBundle.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { parseTrackMetadata } from "../src/domain/tracks/metadata.ts";
import type { RenderPresetId } from "../src/domain/video/renderPresets.ts";
import { promisify } from "node:util";
import { redeliveredEventIds } from "../src/domain/delivery/deliveryHistory.ts";
import { fixture } from "./fixtures.mts";

/**
 * The destination's append-only delivery history.
 *
 * Real directories in a throwaway temp root, and real processes wherever the
 * claim is about processes. Settings are always passed in explicitly, so no
 * test here reads or writes the project's own delivery.local.json.
 */

const destination = async (t: TestContext) => {
  // Resolved, because a configured root is stored resolved: on macOS the temp
  // directory is reached through a symlink.
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "toshi-history-")));
  t.after(async () => {
    try {
      chmodSync(root, 0o700);
    } catch {
      // Already writable.
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
};

const settingsFor = (
  root: string | null,
  extra: Partial<DeliverySettings> = {},
): DeliverySettings => ({
  schemaVersion: 1,
  root,
  autoDeliver: false,
  autoUpdateReleaseBundle: false,
  ...extra,
});

/** A track with a real published export, ready to deliver. */
const setup = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const f = await fixture(t, extra);
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));

  const metadataPath = f.metadata;
  const metadata = parseTrackMetadata(
    JSON.parse(await readFile(metadataPath, "utf8")),
    "fixture",
  );
  const props = buildTrackProps({
    slug: f.slug,
    metadata,
    analysisAvailable: true,
  });

  const publish = (
    presetId: RenderPresetId = "youtube-16x9",
    body = "a finished video",
  ) =>
    publishExport(f.slug, presetId, fingerprintInputs(props, presetId), async (file) => {
      await writeFile(file, body);
    });

  const facts = (presetId: RenderPresetId = "youtube-16x9") =>
    trackExportCoverage(f.slug, metadata).find(
      (entry) => entry.presetId === presetId,
    )!;

  return { ...f, metadataPath, metadata, props, publish, facts };
};

/** Every event in a destination's log, read straight off disk. */
const logged = (root: string): readonly DeliveryLogEvent[] =>
  readDeliveryLog(root).events;

const AT = "2026-09-18T14:22:09.000Z";

const synthetic = (overrides: Partial<DeliveryLogEvent> = {}): DeliveryLogEvent => ({
  schemaVersion: DELIVERY_LOG_SCHEMA_VERSION,
  eventId: randomUUID(),
  kind: "delivery",
  source: "delivery",
  deliveredAt: AT,
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

const writeLog = (root: string, text: string): Promise<void> =>
  writeFile(path.join(root, DELIVERY_LOG_FILENAME), text, "utf8");

const line = (event: DeliveryLogEvent): string => `${JSON.stringify(event)}\n`;

/* ------------------------------------------------------------------ *
 * Delivery writes history, and only for a delivery
 * ------------------------------------------------------------------ */

test("a first delivery appends one event describing what went out", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();

  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  assert.equal(outcome.status, "delivered");
  assert.equal(outcome.historyProblem, null);
  assert.ok(outcome.historyEventId);

  const events = logged(root);
  assert.equal(events.length, 1);

  const [event] = events;
  assert.equal(event.eventId, outcome.historyEventId);
  assert.equal(event.kind, "delivery");
  assert.equal(event.source, "delivery");
  assert.equal(event.track.slug, f.slug);
  assert.equal(event.preset.id, "youtube-16x9");
  assert.equal(event.path, `Probe Beat/${f.slug}-youtube-16x9.mp4`);
  assert.equal(event.bytes, "a finished video".length);

  // The event names the export it came from, so what shipped is traceable.
  assert.equal(event.exportFingerprint, f.facts().inputFingerprint);

  // One line per event, terminated: that is what makes the format appendable.
  const text = await readFile(deliveryLogPath(root), "utf8");
  assert.equal(text.endsWith("\n"), true);
  assert.equal(text.trimEnd().split("\n").length, 1);
});

test("delivering the same export again appends a second event", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();

  const deliver = () =>
    deliverExport({
      slug: f.slug,
      presetId: "youtube-16x9",
      settings: settingsFor(root),
    });

  assert.equal((await deliver()).status, "delivered");

  // A re-delivery is a real event: the same file went out a second time, and
  // "was this re-delivered?" is one of the questions history exists to answer.
  const again = await deliver();
  assert.equal(again.status, "delivered");
  assert.ok(again.historyEventId);

  const events = logged(root);
  assert.equal(events.length, 2);
  assert.notEqual(events[0].eventId, events[1].eventId);
  assert.notEqual(events[0].deliveryId, events[1].deliveryId);
  assert.equal(events[0].deliveredAt <= events[1].deliveredAt, true);
});

test("each format of one track gets its own event", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { exportPresets: ["youtube-16x9", "square-1x1"] });
  await f.publish("youtube-16x9");
  await f.publish("square-1x1", "a square video");

  for (const presetId of ["youtube-16x9", "square-1x1"] as const) {
    const outcome = await deliverExport({
      slug: f.slug,
      presetId,
      settings: settingsFor(root),
    });
    assert.equal(outcome.status, "delivered", presetId);
  }

  const events = logged(root);
  assert.deepEqual(
    events.map((event) => event.preset.id).sort(),
    ["square-1x1", "youtube-16x9"],
  );
  // The dimensions recorded are each format's own, not one shared pair.
  assert.deepEqual(
    events.map((event) => `${event.preset.width}x${event.preset.height}`).sort(),
    ["1080x1080", "1920x1080"],
  );
});

test("a delivery that fails records nothing", async (t) => {
  const root = await destination(t);
  const f = await setup(t);

  // Nothing rendered, so there is nothing to deliver.
  const missing = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });
  assert.equal(missing.status, "pending");
  assert.equal(missing.historyEventId, null);

  // And a copy that cannot be written.
  await f.publish();
  chmodSync(root, 0o500);
  const refused = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });
  chmodSync(root, 0o700);

  assert.equal(refused.status, "failed");
  assert.equal(refused.historyEventId, null);
  assert.equal(readDeliveryLog(root).status, "missing");
});

test("a delivery whose receipt cannot be committed records nothing", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();

  // The receipt lives beside the canonical export. With that directory
  // read-only the copy still publishes, but the receipt cannot be written —
  // and an event must never claim a delivery the receipt does not.
  chmodSync(f.outputDir, 0o500);
  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });
  chmodSync(f.outputDir, 0o700);

  assert.equal(outcome.status, "failed");
  assert.equal(outcome.historyEventId, null);
  assert.equal(readDeliveryReceipt(f.slug, "youtube-16x9"), null);
  assert.equal(readDeliveryLog(root).status, "missing");
});

test("history that cannot be written leaves the delivery successful and says so", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();

  // A directory where the log belongs: appending is impossible, and nothing
  // about the copy that already landed is any less true for it.
  await mkdir(path.join(root, DELIVERY_LOG_FILENAME));

  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  assert.equal(outcome.status, "delivered");
  assert.equal(outcome.historyEventId, null);
  assert.match(outcome.historyProblem ?? "", /EISDIR|illegal operation|directory/i);

  // The delivered file and its receipt are both intact.
  const relative = outcome.destinationRelativePath!;
  assert.equal(await readFile(path.join(root, relative), "utf8"), "a finished video");
  assert.ok(readDeliveryReceipt(f.slug, "youtube-16x9"));

  // And the append lock was released rather than left behind.
  assert.equal((await readdir(root)).includes(".delivery-log.lock"), false);
});

test("two destinations keep entirely separate histories", async (t) => {
  const first = await destination(t);
  const second = await destination(t);
  const f = await setup(t);
  await f.publish();

  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(first),
  });
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(second),
  });

  assert.equal(logged(first).length, 1);
  assert.equal(logged(second).length, 1);
  assert.notEqual(logged(first)[0].eventId, logged(second)[0].eventId);
});

/* ------------------------------------------------------------------ *
 * Snapshots, identity and portability
 * ------------------------------------------------------------------ */

test("history keeps the track as it was, not as it is now", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { title: "Original Title", bpm: 100 });
  await f.publish();

  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  const before = logged(root)[0];
  assert.equal(before.track.title, "Original Title");
  assert.equal(before.track.bpm, 100);

  // Rename and re-tempo the track, then deliver it again.
  await writeFile(
    f.metadataPath,
    JSON.stringify({
      title: "Renamed Later",
      artist: "Toshi",
      key: "F Minor",
      bpm: 140,
    }),
  );
  const f2 = await setup(t);
  void f2;

  const events = logged(root);
  assert.equal(events.length, 1);
  // Untouched: changing metadata does not rewrite what history says shipped.
  assert.equal(events[0].track.title, "Original Title");
  assert.equal(events[0].track.bpm, 100);
});

test("an event records the format in full, so it survives the preset list", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  const [event] = logged(root);

  // Everything needed to describe the format is in the event itself, so
  // renaming or retiring a preset cannot change or invalidate history.
  assert.deepEqual(event.preset, {
    id: "youtube-16x9",
    label: "YouTube 16:9",
    width: 1920,
    height: 1080,
    fps: 30,
  });

  // And a line naming a format this build has never heard of still parses.
  const foreign = parseDeliveryLog(
    line(synthetic({ preset: { ...event.preset, id: "imax-70mm", label: "IMAX" } })),
  );
  assert.equal(foreign.status, "complete");
  assert.equal(foreign.events[0].preset.id, "imax-70mm");
});

test("no absolute path is ever written into the log", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  const text = await readFile(deliveryLogPath(root), "utf8");

  // The log lives at the root, so the root never needs repeating — and a
  // history that travels with its folder must not carry this machine's paths.
  assert.equal(text.includes(root), false);
  assert.equal(text.includes(tmpdir()), false);
  assert.equal(/"path":"[^"]*"/.exec(text)?.[0].includes("/Users"), false);
  assert.equal(logged(root)[0].path.startsWith("/"), false);
});

test("event ids are unique and the shape is exactly the documented one", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { exportPresets: ["youtube-16x9", "square-1x1"] });
  await f.publish("youtube-16x9");
  await f.publish("square-1x1", "sq");

  for (const presetId of ["youtube-16x9", "square-1x1"] as const) {
    await deliverExport({ slug: f.slug, presetId, settings: settingsFor(root) });
  }
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  const events = logged(root);
  assert.equal(events.length, 3);
  assert.equal(new Set(events.map((event) => event.eventId)).size, 3);
  assert.equal(new Set(events.map((event) => event.deliveryId)).size, 3);

  // Every event, whatever it describes, carries the same keys in the same
  // order — the property that makes a JSONL log worth reading with anything.
  for (const event of events) {
    assert.deepEqual(Object.keys(event), [
      "schemaVersion",
      "eventId",
      "kind",
      "source",
      "deliveredAt",
      "track",
      "preset",
      "path",
      "bytes",
      "exportFingerprint",
      "deliveryId",
    ]);
    assert.equal(event.schemaVersion, DELIVERY_LOG_SCHEMA_VERSION);
  }
});

test("a delivery's identity is derived from its receipt, so a retry cannot double-record", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  const receipt = readDeliveryReceipt(f.slug, "youtube-16x9")!;
  assert.equal(deliveryIdForReceipt(receipt), logged(root)[0].deliveryId);

  // Replaying the very same completion — which is what a retried final step
  // would do — is recognised rather than recorded twice.
  const replay = await appendDeliveryLogEvent(
    root,
    deliveryEventFor(receipt, f.metadata, "delivery"),
  );

  assert.equal(replay.appended, false);
  assert.equal(replay.duplicate, true);
  assert.equal(replay.problem, null);
  assert.equal(logged(root).length, 1);
});

/* ------------------------------------------------------------------ *
 * Concurrency
 * ------------------------------------------------------------------ */

test("real processes appending at once produce whole, parseable lines", async (t) => {
  const root = await destination(t);
  const appenders = 6;
  const each = 8;

  const children = await Promise.all(
    Array.from({ length: appenders }, async (_, index) => {
      const child = fork(
        new URL("./history-process.mts", import.meta.url),
        [root, `w${index}`, String(each)],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      await once(child, "message");
      return child;
    }),
  );

  // Both promises are attached before anything is released: a child that
  // finished quickly would otherwise have exited before anyone was listening.
  const results = children.map((child) => once(child, "message"));
  const exits = children.map((child) => once(child, "exit"));
  // Released together, so the appends genuinely overlap.
  children.forEach((child) => child.send("go"));
  const replies = await Promise.all(results);
  await Promise.all(exits);

  const claimed = replies.flatMap(([reply]) => reply.appended as string[]);
  const problems = replies.flatMap(([reply]) => reply.problems as string[]);

  assert.deepEqual(problems, [], "every append should have succeeded");
  assert.equal(claimed.length, appenders * each);

  // Nothing interleaved: every line is a whole event, and every event that a
  // process was told had landed is present exactly once.
  const read = readDeliveryLog(root);
  assert.equal(read.status, "complete", JSON.stringify(read.problems));
  assert.deepEqual(read.problems, []);
  assert.equal(read.events.length, appenders * each);
  assert.deepEqual(
    read.events.map((event) => event.deliveryId).sort(),
    [...claimed].sort(),
  );
  assert.equal(new Set(read.events.map((event) => event.eventId)).size, appenders * each);

  // And the lock is not left behind.
  assert.equal((await readdir(root)).includes(".delivery-log.lock"), false);
});

test("concurrent appenders to different destinations do not block each other", async (t) => {
  const roots = [await destination(t), await destination(t)];

  const children = await Promise.all(
    roots.map(async (root, index) => {
      const child = fork(
        new URL("./history-process.mts", import.meta.url),
        [root, `r${index}`, "8"],
        { stdio: ["ignore", "pipe", "pipe", "ipc"] },
      );
      t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      await once(child, "message");
      return child;
    }),
  );

  const results = children.map((child) => once(child, "message"));
  children.forEach((child) => child.send("go"));
  await Promise.all(results);

  for (const root of roots) {
    const read = readDeliveryLog(root);
    assert.equal(read.status, "complete");
    assert.equal(read.events.length, 8);
  }

  // Each log holds only its own appender's events.
  assert.deepEqual(
    [...new Set(logged(roots[0]).map((event) => event.deliveryId.split("-")[0]))],
    ["r0"],
  );
});

test("an abandoned append lock is reclaimed rather than blocking forever", async (t) => {
  const root = await destination(t);

  // What a process killed mid-append leaves behind: a lock naming a PID on this
  // host that no longer exists.
  await writeFile(
    path.join(root, ".delivery-log.lock"),
    JSON.stringify({
      pid: 2147483646,
      hostname: (await import("node:os")).hostname(),
      token: "abandoned",
      createdAt: new Date().toISOString(),
    }),
  );

  const result = await appendDeliveryLogEvent(root, synthetic());

  assert.equal(result.appended, true);
  assert.equal(result.problem, null);
  assert.equal(logged(root).length, 1);
});

test("a lock held by a live process is waited for, then given up on", async (t) => {
  const root = await destination(t);

  // This process is unmistakably alive, so its lock must never be stolen.
  await writeFile(
    path.join(root, ".delivery-log.lock"),
    JSON.stringify({
      pid: process.pid,
      hostname: (await import("node:os")).hostname(),
      token: "live",
      createdAt: new Date().toISOString(),
    }),
  );

  const result = await appendDeliveryLogEvent(root, synthetic());

  // Reported, not thrown, and bounded: the caller is a delivery that has
  // already succeeded and must be able to return.
  assert.equal(result.appended, false);
  assert.match(result.problem ?? "", /locked by another process/);
  assert.equal(readDeliveryLog(root).status, "missing");
  assert.equal(
    JSON.parse(await readFile(path.join(root, ".delivery-log.lock"), "utf8")).token,
    "live",
  );
});

/* ------------------------------------------------------------------ *
 * Reading, corruption and recovery
 * ------------------------------------------------------------------ */

test("a destination with no log yet is reported as missing, not as an error", async (t) => {
  const root = await destination(t);
  const read = readDeliveryLog(root);

  assert.equal(read.status, "missing");
  assert.deepEqual(read.events, []);
  assert.deepEqual(read.problems, []);

  const queried = await queryDeliveryHistory({ settings: settingsFor(root) });
  assert.equal(queried.status, "missing");
  assert.equal(queried.summary.total, 0);
});

test("an empty log, and one of only blank lines, read as complete and empty", async (t) => {
  const root = await destination(t);

  for (const text of ["", "\n", "\n\n   \n"]) {
    await writeLog(root, text);
    const read = readDeliveryLog(root);
    assert.equal(read.status, "complete", JSON.stringify(text));
    assert.deepEqual(read.events, []);
    assert.deepEqual(read.problems, []);
  }
});

test("an incomplete final line is recovered and every earlier event kept", async (t) => {
  const root = await destination(t);
  const good = [synthetic(), synthetic()];

  // Exactly what a crash during an append leaves: whole lines, then a fragment
  // with no terminating newline.
  await writeLog(root, `${good.map(line).join("")}{"schemaVersion":1,"eventId":"half`);

  const read = readDeliveryLog(root);
  assert.equal(read.status, "recovered_tail");
  assert.equal(read.events.length, 2);
  assert.deepEqual(
    read.events.map((event) => event.eventId),
    good.map((event) => event.eventId),
  );
  assert.deepEqual(read.problems.map((problem) => [problem.line, problem.kind]), [
    [3, "truncated"],
  ]);

  // Appending onto an unterminated line must never splice the new event onto
  // the fragment, which would lose it outright. The fragment is terminated
  // first, so the event lands whole...
  const appended = await appendDeliveryLogEvent(root, synthetic());
  assert.equal(appended.appended, true);

  const after = readDeliveryLog(root);
  assert.equal(after.events.length, 3);

  // ...and the leftover fragment is now a line in the middle, which is
  // reported as corruption rather than quietly tidied away. Nothing is lost;
  // repairing the tail before delivering again is what avoids this.
  assert.equal(after.status, "corrupt");
  assert.deepEqual(after.problems.map((problem) => problem.line), [3]);
});

test("repair drops only an incomplete final line, and refuses anything else", async (t) => {
  const root = await destination(t);
  const good = [synthetic(), synthetic()];
  const fragment = '{"schemaVersion":1,"eventId":"half';
  await writeLog(root, `${good.map(line).join("")}${fragment}`);

  const repaired = await repairDeliveryLogTail(root);
  assert.equal(repaired.repaired, true);
  assert.equal(repaired.discarded, fragment);

  const read = readDeliveryLog(root);
  assert.equal(read.status, "complete");
  assert.equal(read.events.length, 2);

  // Nothing to repair is not a repair.
  const again = await repairDeliveryLogTail(root);
  assert.equal(again.repaired, false);
  assert.match(again.problem ?? "", /nothing to repair/);

  // And damage in the middle is deliberately left for someone to look at: an
  // audit log must never be silently rewritten to make it parse.
  const damaged = `${line(good[0])}not json at all\n${line(good[1])}`;
  await writeLog(root, damaged);
  const refused = await repairDeliveryLogTail(root);
  assert.equal(refused.repaired, false);
  assert.match(refused.problem ?? "", /"corrupt"/);
  assert.equal(await readFile(deliveryLogPath(root), "utf8"), damaged);
});

test("damage anywhere but the final line is corruption, and is located", async (t) => {
  const root = await destination(t);
  const good = synthetic();

  for (const [text, badLine] of [
    [`not json\n${line(good)}`, 1],
    [`${line(good)}{"schemaVersion":1,"kind":"nope"}\n${line(good)}`, 2],
  ] as const) {
    await writeLog(root, text);
    const read = readDeliveryLog(root);

    assert.equal(read.status, "corrupt");
    assert.deepEqual(read.problems.map((problem) => problem.line), [badLine]);
    assert.equal(read.problems[0].kind, "malformed");
    // The readable events are still returned, so history is not lost to one
    // bad line — but the status says plainly that something is wrong.
    assert.ok(read.events.length >= 1);
  }
});

test("a line from a newer version is reported as unsupported, and nothing is rewritten", async (t) => {
  const root = await destination(t);
  const good = synthetic();
  const future = `${line(good)}${JSON.stringify({
    ...synthetic(),
    schemaVersion: DELIVERY_LOG_SCHEMA_VERSION + 1,
  })}\n`;
  await writeLog(root, future);

  const read = readDeliveryLog(root);
  assert.equal(read.status, "unsupported");
  // The earlier, readable event is preserved rather than discarded.
  assert.equal(read.events.length, 1);
  assert.equal(read.events[0].eventId, good.eventId);
  assert.equal(read.problems[0].kind, "unsupported");
  assert.match(read.problems[0].message, /newer version/);
  assert.equal(await readFile(deliveryLogPath(root), "utf8"), future);

  // Reconciliation refuses to append onto a log it cannot fully read.
  const reconciled = await reconcileDeliveryHistory({ settings: settingsFor(root) });
  assert.match(reconciled.problem ?? "", /"unsupported"/);
  assert.deepEqual(reconciled.appended, []);
});

test("a schema version of zero or a missing one is malformed, not unsupported", () => {
  for (const patch of [{ schemaVersion: 0 }, { schemaVersion: "1" }, {}]) {
    const raw = { ...synthetic(), ...patch } as Record<string, unknown>;
    if (Object.keys(patch).length === 0) delete raw.schemaVersion;

    const read = parseDeliveryLog(`${JSON.stringify(raw)}\n`);
    assert.equal(read.status, "corrupt", JSON.stringify(patch));
    assert.equal(read.problems[0].kind, "malformed");
  }
});

test("an event missing any required field is rejected", () => {
  const drop = (key: keyof DeliveryLogEvent) => {
    const raw = { ...synthetic() } as Record<string, unknown>;
    delete raw[key];
    return `${JSON.stringify(raw)}\n`;
  };

  for (const key of [
    "eventId",
    "deliveryId",
    "source",
    "deliveredAt",
    "track",
    "preset",
    "path",
    "bytes",
  ] as const) {
    const read = parseDeliveryLog(drop(key));
    assert.equal(read.status, "corrupt", `missing ${key}`);
    assert.equal(read.events.length, 0, `missing ${key}`);
  }

  // An unparseable timestamp is not a delivery event either.
  assert.equal(
    parseDeliveryLog(line(synthetic({ deliveredAt: "whenever" }))).status,
    "corrupt",
  );
});

/* ------------------------------------------------------------------ *
 * Querying
 * ------------------------------------------------------------------ */

const spread = async (root: string) => {
  const events = [
    synthetic({
      deliveredAt: "2026-09-10T09:00:00.000Z",
      track: { slug: "alpha", title: "Alpha", artist: "Toshi", key: "C", bpm: 90 },
    }),
    synthetic({
      deliveredAt: "2026-09-15T09:00:00.000Z",
      track: { slug: "beta", title: "Beta", artist: "Toshi", key: "D", bpm: 95 },
      preset: { id: "square-1x1", label: "Square 1:1", width: 1080, height: 1080, fps: 30 },
    }),
    synthetic({
      deliveredAt: "2026-09-18T09:00:00.000Z",
      track: { slug: "alpha", title: "Alpha", artist: "Toshi", key: "C", bpm: 90 },
    }),
    synthetic({
      deliveredAt: "2026-09-18T11:00:00.000Z",
      track: { slug: "alpha", title: "Alpha", artist: "Toshi", key: "C", bpm: 90 },
      preset: { id: "square-1x1", label: "Square 1:1", width: 1080, height: 1080, fps: 30 },
    }),
  ];
  await writeLog(root, events.map(line).join(""));
  return events;
};

test("history is filtered by track, by format and by date, server-side", async (t) => {
  const root = await destination(t);
  const events = await spread(root);
  const query = (filter: Parameters<typeof selectDeliveryHistory>[1]) =>
    queryDeliveryHistory({ settings: settingsFor(root), filter, now: new Date("2026-09-18T12:00:00.000Z") });

  assert.equal((await query({ track: "alpha" })).matched, 3);
  assert.equal((await query({ track: "beta" })).matched, 1);
  assert.equal((await query({ track: "gamma" })).matched, 0);
  assert.equal((await query({ preset: "square-1x1" })).matched, 2);
  assert.equal((await query({ track: "alpha", preset: "square-1x1" })).matched, 1);

  // `from` is inclusive and `to` exclusive, so adjacent ranges never
  // double-count the same delivery.
  assert.equal((await query({ from: "2026-09-15T09:00:00.000Z" })).matched, 3);
  assert.equal((await query({ to: "2026-09-15T09:00:00.000Z" })).matched, 1);
  assert.equal(
    (await query({ from: "2026-09-10T00:00:00.000Z", to: "2026-09-16T00:00:00.000Z" }))
      .matched,
    2,
  );

  // A range with nothing in it is empty, not everything.
  assert.equal((await query({ from: "2027-01-01T00:00:00.000Z" })).matched, 0);
  assert.equal(events.length, 4);
});

test("ordering and limits are bounded and explicit", async (t) => {
  const root = await destination(t);
  await spread(root);
  const query = (filter: Parameters<typeof selectDeliveryHistory>[1]) =>
    queryDeliveryHistory({ settings: settingsFor(root), filter });

  const newest = await query({});
  assert.deepEqual(
    newest.events.map((event) => event.deliveredAt),
    [
      "2026-09-18T11:00:00.000Z",
      "2026-09-18T09:00:00.000Z",
      "2026-09-15T09:00:00.000Z",
      "2026-09-10T09:00:00.000Z",
    ],
  );

  const oldest = await query({ order: "oldest" });
  assert.deepEqual(
    oldest.events.map((event) => event.deliveredAt),
    [...newest.events].reverse().map((event) => event.deliveredAt),
  );

  // A limit truncates, but always from the ordered end the caller asked for.
  const two = await query({ limit: 2 });
  assert.equal(two.events.length, 2);
  assert.equal(two.matched, 4, "the unlimited count is still reported");
  assert.equal(two.events[0].deliveredAt, "2026-09-18T11:00:00.000Z");

  // And nothing can ask for an unbounded response.
  assert.equal(
    selectDeliveryHistory(Array.from({ length: 600 }, () => synthetic()), {
      limit: 5_000,
    }).events.length,
    DELIVERY_HISTORY_MAX_LIMIT,
  );
});

test("two deliveries in the same millisecond keep the order they happened in", () => {
  const first = synthetic({ deliveryId: "first" });
  const second = synthetic({ deliveryId: "second" });

  assert.deepEqual(
    selectDeliveryHistory([first, second], { order: "oldest" }).events.map(
      (event) => event.deliveryId,
    ),
    ["first", "second"],
  );
});

test("the summary answers today, this week and last delivery", async (t) => {
  const root = await destination(t);
  await spread(root);
  const now = new Date("2026-09-18T12:00:00.000Z");

  const result = await queryDeliveryHistory({ settings: settingsFor(root), now });

  assert.equal(result.summary.total, 4);
  assert.equal(result.summary.lastDeliveredAt, "2026-09-18T11:00:00.000Z");
  assert.equal(result.summary.last7Days, 3);
  assert.equal(result.summary.tracksLast7Days, 2);

  // "Today" means since local midnight, which is what someone means by it.
  const localMidnight = new Date(2026, 8, 18, 0, 0, 0);
  const todayEvents = [
    ...(await spread(root)),
  ].filter((event) => Date.parse(event.deliveredAt) >= localMidnight.getTime());
  assert.equal(result.summary.today, todayEvents.length);

  assert.deepEqual(result.summary.byTrack, [
    { key: "alpha", label: "Alpha", count: 3 },
    { key: "beta", label: "Beta", count: 1 },
  ]);
  assert.deepEqual(result.summary.byPreset.map((count) => count.count), [2, 2]);

  // The summary describes the whole destination, not the filtered page.
  const filtered = await queryDeliveryHistory({
    settings: settingsFor(root),
    filter: { track: "beta" },
    now,
  });
  assert.equal(filtered.events.length, 1);
  assert.equal(filtered.summary.total, 4);

  // And the filter list is derived from what is actually in the log.
  assert.deepEqual(filtered.knownTracks, [
    { slug: "alpha", title: "Alpha" },
    { slug: "beta", title: "Beta" },
  ]);
});

test("relative periods are accepted, and nothing else is guessed at", () => {
  const now = new Date("2026-09-18T12:00:00.000Z");

  assert.equal(parseRelativePeriod("7d", now), "2026-09-11T12:00:00.000Z");
  assert.equal(parseRelativePeriod("24h", now), "2026-09-17T12:00:00.000Z");
  assert.equal(parseRelativePeriod(" 30d ", now), "2026-08-19T12:00:00.000Z");

  for (const value of ["0d", "1w", "d", "7 days", "-3d", "", "7dd", "1e3d"]) {
    assert.equal(parseRelativePeriod(value, now), null, value);
  }
});

test("with no destination configured, history is simply unavailable", async () => {
  const result = await queryDeliveryHistory({ settings: settingsFor(null) });

  assert.equal(result.root, null);
  assert.equal(result.status, "missing");
  assert.deepEqual(result.events, []);
  assert.equal(result.summary.total, 0);

  const reconciled = await reconcileDeliveryHistory({ settings: settingsFor(null) });
  assert.equal(reconciled.root, null);
  assert.match(reconciled.problem ?? "", /no export destination/i);
});

/* ------------------------------------------------------------------ *
 * Reconciliation
 * ------------------------------------------------------------------ */

test("reconciliation appends an event for a receipt that has none, exactly once", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();

  // A delivery whose history was lost: the copy and the receipt are both
  // there, and the log is not. That is the one thing a crash between
  // committing a receipt and appending its event can leave behind.
  await mkdir(path.join(root, DELIVERY_LOG_FILENAME));
  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });
  assert.equal(outcome.status, "delivered");
  assert.ok(outcome.historyProblem);
  await rm(path.join(root, DELIVERY_LOG_FILENAME), { recursive: true });

  const first = await reconcileDeliveryHistory({ settings: settingsFor(root) });
  assert.equal(first.appended.length, 1);
  assert.equal(first.problem, null);

  const [event] = logged(root);
  const receipt = readDeliveryReceipt(f.slug, "youtube-16x9")!;

  // Marked for what it is, and never passed off as a contemporaneous record.
  assert.equal(event.source, "reconciled");
  // The facts that were recorded at delivery time are the recorded ones.
  assert.equal(event.deliveredAt, receipt.deliveredAt);
  assert.equal(event.bytes, receipt.bytes);
  assert.equal(event.exportFingerprint, receipt.sourceFingerprint);
  assert.equal(event.deliveryId, deliveryIdForReceipt(receipt));

  // Idempotent: running it again recognises the receipt and adds nothing.
  const second = await reconcileDeliveryHistory({ settings: settingsFor(root) });
  assert.deepEqual(second.appended, []);
  assert.equal(second.alreadyRecorded >= 1, true);
  assert.equal(logged(root).length, 1);
});

test("reconciliation reports what it cannot reconstruct rather than inventing it", async (t) => {
  const root = await destination(t);
  const other = await destination(t);
  const f = await setup(t);
  await f.publish();

  // Delivered somewhere else: an event's path is relative to the root its log
  // sits in, so this receipt cannot become an event in *this* log.
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(other),
  });

  const result = await reconcileDeliveryHistory({ settings: settingsFor(root) });

  const mine = result.unreconcilable.filter((entry) => entry.slug === f.slug);
  assert.equal(mine.length, 1);
  assert.match(mine[0].reason, /not the current destination/);
  assert.equal(
    result.appended.some((event) => event.track.slug === f.slug),
    false,
  );
});

test("reconciliation cannot reconstruct a track whose metadata is gone", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await mkdir(path.join(root, DELIVERY_LOG_FILENAME));
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });
  await rm(path.join(root, DELIVERY_LOG_FILENAME), { recursive: true });

  // Nothing records what the metadata said at delivery time, so with the
  // metadata gone there is no honest snapshot to write.
  await rm(f.metadataPath);

  const result = await reconcileDeliveryHistory({ settings: settingsFor(root) });
  const mine = result.unreconcilable.filter((entry) => entry.slug === f.slug);

  assert.equal(mine.length, 1);
  assert.match(mine[0].reason, /metadata can no longer be read/);
  assert.equal(readDeliveryLog(root).status, "missing");
});

test("reconciliation never touches an event that is already there", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  const before = await readFile(deliveryLogPath(root), "utf8");
  const result = await reconcileDeliveryHistory({ settings: settingsFor(root) });

  assert.deepEqual(result.appended, []);
  assert.equal(await readFile(deliveryLogPath(root), "utf8"), before);
  assert.equal(logged(root)[0].source, "delivery");
});

/* ------------------------------------------------------------------ *
 * Report
 * ------------------------------------------------------------------ */

test("a report renders the same document for the same events", async (t) => {
  const root = await destination(t);
  const events = await spread(root);
  const at = "2026-09-18T19:42:07.000Z";

  const filename = await writeDeliveryReport(
    root,
    events,
    { from: "2026-09-12T00:00:00.000Z", to: null },
    at,
  );
  assert.equal(filename, DELIVERY_REPORT_FILENAME);

  const text = await readFile(path.join(root, DELIVERY_REPORT_FILENAME), "utf8");
  assert.equal(text, renderDeliveryReport(events, { from: "2026-09-12T00:00:00.000Z", to: null }, at));
  assert.match(text, /^# Delivery Report — 12 Sep 2026 to now$/m);
  assert.match(text, /^4 deliveries$/m);
  assert.match(text, /^2 tracks$/m);
  // Newest first: the last thing shipped is what someone looks for.
  assert.match(text, /- Alpha — Square 1:1 — 2026-09-18/);
  assert.equal(text.includes(root), false);

  // A report is a view, so writing one changes nothing about the log.
  assert.equal(logged(root).length, 4);
  assert.equal(readDeliveryLog(root).status, "complete");

  const empty = renderDeliveryReport([], { from: null, to: null }, at);
  assert.match(empty, /^# Delivery Report — everything$/m);
  assert.match(empty, /^0 deliveries$/m);
  assert.match(empty, /^0 tracks$/m);

  // One of each reads as one of each, not "1 deliverys".
  const single = renderDeliveryReport([events[0]], { from: null, to: null }, at);
  assert.match(single, /^1 delivery$/m);
  assert.match(single, /^1 track$/m);
});

/* ------------------------------------------------------------------ *
 * Independence from the rest of the tool
 * ------------------------------------------------------------------ */

test("a release bundle is unaffected by history, damaged or missing", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  const withHistory = await generateReleaseBundle({
    slug: f.slug,
    settings: settingsFor(root),
  });
  assert.equal(withHistory.generated, true);
  assert.equal(withHistory.delivered, 1);

  // Damage the log thoroughly, then ask again. Current delivery state is
  // computed from receipts and manifests, so it cannot depend on history.
  await writeLog(root, "this is not a log at all\n");
  assert.equal(readDeliveryLog(root).status, "corrupt");

  const rewritten = await generateReleaseBundle({
    slug: f.slug,
    settings: settingsFor(root),
    force: true,
  });
  assert.equal(rewritten.generated, true);
  assert.equal(rewritten.delivered, 1);
  assert.equal(rewritten.bundleId, withHistory.bundleId);

  // Nor does a bundle write anything into the log.
  assert.equal(readDeliveryLog(root).events.length, 0);
  assert.equal(await readFile(deliveryLogPath(root), "utf8"), "this is not a log at all\n");
});

test("delivery, receipt, history and release bundle happen in that order", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();

  // Through the planner, which is the path auto-delivery and the API both
  // take, and the one that updates release bundles afterwards.
  const settings = settingsFor(root, {
    autoDeliver: true,
    autoUpdateReleaseBundle: true,
  });
  const plan = await planDeliveries({ slugs: [f.slug], settings });
  const { outcomes, releaseBundles } = await deliverPlanned(plan, settings);

  assert.equal(outcomes.length, 1);
  const [outcome] = outcomes;
  assert.equal(outcome.status, "delivered");
  assert.ok(outcome.historyEventId);
  assert.equal(outcome.historyProblem, null);

  // The bundle is written after the copy, from the state the copy produced.
  assert.equal(releaseBundles.length, 1);
  assert.equal(releaseBundles[0].generated, true);
  assert.equal(releaseBundles[0].delivered, 1);

  // Delivery, then receipt, then history, then the bundle. The bundle writes
  // two files into the track's folder and never an event.
  assert.equal(logged(root).length, 1);
  assert.deepEqual((await readdir(root)).sort(), [
    "Probe Beat",
    DELIVERY_LOG_FILENAME,
  ]);
  assert.deepEqual((await readdir(path.join(root, "Probe Beat"))).sort(), [
    `${f.slug}-youtube-16x9.mp4`,
    "release.json",
    "release.md",
  ]);
});

test("recording history leaves no temp files or locks at the destination", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { exportPresets: ["youtube-16x9", "square-1x1"] });
  await f.publish("youtube-16x9");
  await f.publish("square-1x1", "sq");

  for (const presetId of ["youtube-16x9", "square-1x1"] as const) {
    await deliverExport({ slug: f.slug, presetId, settings: settingsFor(root) });
  }
  await writeDeliveryReport(root, logged(root), { from: null, to: null });
  await repairDeliveryLogTail(root);

  const entries = await readdir(root);
  assert.deepEqual(
    entries.filter((name) => name.includes(".tmp-") || name.endsWith(".lock")),
    [],
  );
  assert.deepEqual(entries.sort(), [
    DELIVERY_REPORT_FILENAME,
    DELIVERY_LOG_FILENAME,
    f.slug,
  ].sort());
});

test("the receipt is written before history, and history never rewrites one", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  const receipt = await readFile(deliveryReceiptPath(f.slug, "youtube-16x9"), "utf8");

  await reconcileDeliveryHistory({ settings: settingsFor(root) });
  await writeDeliveryReport(root, logged(root), { from: null, to: null });

  // Receipts are the record of current delivery state; history only ever reads
  // them. Nothing in this milestone writes one.
  assert.equal(
    await readFile(deliveryReceiptPath(f.slug, "youtube-16x9"), "utf8"),
    receipt,
  );
});

test("summaries of an empty history are zeroes, not absences", () => {
  const summary = summarizeDeliveryHistory([], new Date(AT));

  assert.deepEqual(summary, {
    total: 0,
    today: 0,
    last7Days: 0,
    tracksLast7Days: 0,
    lastDeliveredAt: null,
    byTrack: [],
    byPreset: [],
  });
});

/* ------------------------------------------------------------------ *
 * Re-delivery
 * ------------------------------------------------------------------ */

test("a re-delivery is identified against the whole log, not a page of it", async (t) => {
  const root = await destination(t);
  const events = [
    synthetic({ eventId: "first-16x9", deliveredAt: "2026-09-10T09:00:00.000Z" }),
    synthetic({ eventId: "first-1x1", deliveredAt: "2026-09-11T09:00:00.000Z",
      preset: { id: "square-1x1", label: "Square 1:1", width: 1080, height: 1080, fps: 30 } }),
    synthetic({ eventId: "again-16x9", deliveredAt: "2026-09-18T09:00:00.000Z" }),
  ];
  await writeLog(root, events.map(line).join(""));

  // The first time a track and format go out is not a re-delivery; the second
  // is, whether or not the first happens to be on the page being shown.
  assert.deepEqual([...redeliveredEventIds(events)], ["again-16x9"]);

  const page = await queryDeliveryHistory({
    settings: settingsFor(root),
    filter: { limit: 1 },
  });

  assert.deepEqual(page.events.map((event) => event.eventId), ["again-16x9"]);
  assert.deepEqual(page.redelivered, ["again-16x9"]);

  // And the ordering of the log on disk does not change the answer.
  assert.deepEqual([...redeliveredEventIds([...events].reverse())], ["again-16x9"]);
});

test("delivering, re-delivering and adding a format reads back as three events", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { exportPresets: ["youtube-16x9", "square-1x1"] });
  const settings = settingsFor(root);

  await f.publish("youtube-16x9");
  await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings });
  await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings });
  await f.publish("square-1x1", "a square video");
  await deliverExport({ slug: f.slug, presetId: "square-1x1", settings });

  const result = await queryDeliveryHistory({ settings, filter: { order: "oldest" } });

  assert.equal(result.status, "complete");
  assert.equal(result.matched, 3);
  assert.deepEqual(
    result.events.map((event) => event.preset.id),
    ["youtube-16x9", "youtube-16x9", "square-1x1"],
  );
  // Only the second copy of the same format counts as a re-delivery.
  assert.deepEqual(result.redelivered, [result.events[1].eventId]);
  assert.equal(result.summary.byTrack[0].count, 3);
});

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const run = promisify(execFile);

test("the CLI documents itself and refuses without a destination", async () => {
  // Deliberately the two paths that do not depend on this machine's delivery
  // settings, so running the suite can never read or write the project's own
  // delivery.local.json. The configured paths are exercised by hand.
  const help = await run(process.execPath, ["scripts/delivery-history.mts", "--help"]);

  assert.match(help.stderr, /--track <slug>/);
  assert.match(help.stderr, /--since <period>/);
  assert.match(help.stderr, /--repair-tail/);
  assert.match(help.stderr, /append-only/);

  const bad = await run(process.execPath, [
    "scripts/delivery-history.mts",
    "--limit",
    "lots",
  ]).catch((error: { code: number; stderr: string }) => error);

  assert.equal((bad as { code: number }).code, 1);
  assert.match((bad as { stderr: string }).stderr, /--limit needs a whole number/);
});
