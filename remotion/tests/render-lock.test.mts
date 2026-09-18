import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  acquireRenderTargetLock,
  inspectRenderTargetLock,
  listRenderLocks,
  releaseRenderTargetLock,
  renderLockFile,
  RENDER_LOCK_SCHEMA_VERSION,
  withRenderTargetLock,
} from "../services/render/renderLock.ts";

/**
 * Cross-process render target locks.
 *
 * These use real filesystem primitives in a throwaway directory, because the
 * whole point of the mechanism is what the filesystem does with O_EXCL — a
 * mocked filesystem would prove nothing about it.
 */

const lockRoot = async (t: TestContext) => {
  const root = await mkdtemp(path.join(tmpdir(), "toshi-locks-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

/**
 * Another process on this machine, as seen from here.
 *
 * `isAlive` matters on the *reading* side — it is what an acquisition consults
 * about an existing lock — so contending calls pass it too. Without it, a PID
 * that genuinely does not exist here is correctly treated as abandoned, which
 * is a different test.
 */
const otherLiveProcess = { pid: 424242, isAlive: () => true };
const deadProcess = { pid: 424243, isAlive: () => false };

test("the first caller acquires a target, and the lock says who holds it", async (t) => {
  const root = await lockRoot(t);

  const lock = acquireRenderTargetLock("ghetto-geek", "square-1x1", {
    root,
    jobId: "job-1",
  });

  assert.equal(lock.slug, "ghetto-geek");
  assert.equal(lock.presetId, "square-1x1");

  const state = inspectRenderTargetLock("ghetto-geek", "square-1x1", { root });
  assert.equal(state.state, "held");
  assert.equal(state.state === "held" && state.owner.pid, process.pid);
  assert.equal(state.state === "held" && state.owner.jobId, "job-1");
  assert.equal(
    state.state === "held" && state.owner.schemaVersion,
    RENDER_LOCK_SCHEMA_VERSION,
  );

  lock.release();
  assert.equal(
    inspectRenderTargetLock("ghetto-geek", "square-1x1", { root }).state,
    "free",
  );
});

test("a second caller cannot take a target another process holds", async (t) => {
  const root = await lockRoot(t);

  // Written as if by a live process that is not this one, which is what a
  // separate CLI or server process looks like from here.
  acquireRenderTargetLock("ghetto-geek", "square-1x1", {
    root,
    ...otherLiveProcess,
  });

  assert.throws(
    () =>
      acquireRenderTargetLock("ghetto-geek", "square-1x1", {
        root,
        isAlive: otherLiveProcess.isAlive,
      }),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "RENDER_TARGET_LOCKED");
      assert.match(error.message, /ghetto-geek \/ square-1x1/);
      assert.match(error.message, /424242/, "says which process holds it");
      assert.match(error.message, /render-locks/, "points at the way out");
      return true;
    },
  );
});

test("another format of the same track is a different target", async (t) => {
  const root = await lockRoot(t);

  acquireRenderTargetLock("ghetto-geek", "square-1x1", {
    root,
    ...otherLiveProcess,
  });

  // Independent targets must not block each other, or a batch rendering three
  // formats of one track would serialize on the first.
  assert.doesNotThrow(() =>
    acquireRenderTargetLock("ghetto-geek", "youtube-16x9", {
      root,
      isAlive: otherLiveProcess.isAlive,
    }),
  );
  assert.doesNotThrow(() =>
    acquireRenderTargetLock("ghetto-geek", "vertical-9x16", {
      root,
      isAlive: otherLiveProcess.isAlive,
    }),
  );
});

test("the same format of another track is a different target", async (t) => {
  const root = await lockRoot(t);

  acquireRenderTargetLock("ghetto-geek", "square-1x1", {
    root,
    ...otherLiveProcess,
  });

  assert.doesNotThrow(() =>
    acquireRenderTargetLock("midnight-rider", "square-1x1", {
      root,
      isAlive: otherLiveProcess.isAlive,
    }),
  );
});

test("work releases its lock whether it succeeds or throws", async (t) => {
  const root = await lockRoot(t);
  const free = () =>
    inspectRenderTargetLock("zz-track", "square-1x1", { root }).state === "free";

  await withRenderTargetLock(
    "zz-track",
    "square-1x1",
    async () => {
      assert.equal(free(), false, "held for the duration of the work");
    },
    { root },
  );
  assert.equal(free(), true, "released after success");

  await assert.rejects(
    () =>
      withRenderTargetLock(
        "zz-track",
        "square-1x1",
        async () => {
          throw new Error("render failed");
        },
        { root },
      ),
    /render failed/,
  );
  assert.equal(free(), true, "released after failure");

  // Cancellation reaches the render as a thrown error, so it takes the same
  // path — asserted separately because it is a distinct lifecycle claim.
  await assert.rejects(
    () =>
      withRenderTargetLock(
        "zz-track",
        "square-1x1",
        async () => {
          throw new Error("renderMedia() got cancelled");
        },
        { root },
      ),
    /cancelled/,
  );
  assert.equal(free(), true, "released after cancellation");

  // And the target is usable again afterwards.
  assert.doesNotThrow(() =>
    acquireRenderTargetLock("zz-track", "square-1x1", { root }),
  );
});

test("releasing twice is harmless, and never removes a successor's lock", async (t) => {
  const root = await lockRoot(t);

  const first = acquireRenderTargetLock("zz-track", "square-1x1", { root });
  first.release();
  first.release();

  const second = acquireRenderTargetLock("zz-track", "square-1x1", { root });

  // The first owner coming back late must not delete the lock that replaced it.
  first.release();

  const state = inspectRenderTargetLock("zz-track", "square-1x1", { root });
  assert.equal(state.state, "held");
  assert.equal(state.state === "held" && state.owner.token, second.token);
});

test("a lock whose process is gone is reclaimed by the next render", async (t) => {
  const root = await lockRoot(t);

  acquireRenderTargetLock("zz-track", "square-1x1", { root, ...deadProcess });

  // A worker killed mid-render cannot release anything, so the abandoned file
  // must not brick the target forever.
  const reclaimed = acquireRenderTargetLock("zz-track", "square-1x1", {
    root,
    isAlive: deadProcess.isAlive,
  });

  assert.equal(reclaimed.slug, "zz-track");
  const state = inspectRenderTargetLock("zz-track", "square-1x1", { root });
  assert.equal(state.state === "held" && state.owner.pid, process.pid);

  // Nothing is left behind by the reclaim itself.
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.includes("abandoned")),
    [],
  );
});

test("a lock from another machine is never reclaimed automatically", async (t) => {
  const root = await lockRoot(t);

  // PID liveness says nothing about a process on a different host, so even a
  // PID that looks dead here must be left alone.
  acquireRenderTargetLock("zz-track", "square-1x1", {
    root,
    hostname: "some-other-mac",
    pid: 999999,
  });

  assert.throws(
    () =>
      acquireRenderTargetLock("zz-track", "square-1x1", {
        root,
        hostname: "this-mac",
        isAlive: () => false,
      }),
    { code: "RENDER_TARGET_LOCKED" },
  );
});

test("a malformed lock is left alone rather than guessed at", async (t) => {
  const root = await lockRoot(t);
  const file = renderLockFile("zz-track", "square-1x1", root);

  for (const contents of [
    "{ not json",
    "",
    JSON.stringify({ schemaVersion: 99, pid: process.pid }),
    JSON.stringify({ schemaVersion: 1, pid: "not-a-pid", token: "x" }),
  ]) {
    await writeFile(file, contents);

    assert.equal(
      inspectRenderTargetLock("zz-track", "square-1x1", { root }).state,
      "malformed",
    );
    assert.throws(
      () =>
        acquireRenderTargetLock("zz-track", "square-1x1", {
          root,
          isAlive: () => false,
        }),
      { code: "RENDER_TARGET_LOCKED" },
      `unreadable metadata must not be reclaimed: ${contents}`,
    );
  }

  // The explicit recovery path is what clears it.
  assert.equal(releaseRenderTargetLock("zz-track", "square-1x1", { root }), true);
  assert.doesNotThrow(() =>
    acquireRenderTargetLock("zz-track", "square-1x1", { root }),
  );
});

test("explicit release takes a target, never a path", async (t) => {
  const root = await lockRoot(t);

  assert.equal(
    releaseRenderTargetLock("zz-track", "square-1x1", { root }),
    false,
    "releasing nothing is not an error",
  );

  acquireRenderTargetLock("zz-track", "square-1x1", { root, ...otherLiveProcess });
  assert.equal(releaseRenderTargetLock("zz-track", "square-1x1", { root }), true);

  for (const slug of ["../../etc/passwd", "..", "/absolute", "with/slash", ""]) {
    assert.throws(
      () => releaseRenderTargetLock(slug, "square-1x1", { root }),
      { code: "INVALID_SLUG" },
      `slug must not reach the filesystem: ${slug}`,
    );
  }

  assert.throws(
    () => renderLockFile("zz-track", "../escape" as never, root),
    { code: "INVALID_PRESET" },
  );
});

test("a lock path stays directly inside the lock root", async (t) => {
  const root = await lockRoot(t);
  const file = renderLockFile("zz-track", "square-1x1", root);

  assert.equal(path.dirname(file), path.resolve(root));
  assert.equal(path.basename(file), "zz-track__square-1x1.lock");
  assert.equal(file, path.resolve(file), "absolute, so no cwd dependence");
});

test("locks on disk can be listed, with abandoned ones marked", async (t) => {
  const root = await lockRoot(t);

  acquireRenderTargetLock("aa-track", "square-1x1", { root, ...otherLiveProcess });
  acquireRenderTargetLock("zz-track", "youtube-16x9", { root, ...deadProcess });

  const entries = listRenderLocks({ root, isAlive: (pid) => pid === 424242 });

  assert.deepEqual(
    entries.map((entry) => `${entry.slug}/${entry.presetId}:${entry.abandoned}`),
    ["aa-track/square-1x1:false", "zz-track/youtube-16x9:true"],
  );
  assert.equal(entries[0].owner?.pid, 424242);

  // An empty or absent root lists nothing rather than throwing.
  assert.deepEqual(listRenderLocks({ root: path.join(root, "nope") }), []);
});

test("only one of many concurrent acquisitions wins a target", async (t) => {
  const root = await lockRoot(t);

  // Same-process concurrency cannot prove cross-process exclusion on its own,
  // but it does prove the creation is the decision point rather than any
  // check-then-write: exactly one of these may succeed.
  const results = await Promise.all(
    Array.from({ length: 12 }, async () => {
      try {
        acquireRenderTargetLock("zz-track", "square-1x1", { root });
        return "acquired";
      } catch (error) {
        return (error as { code?: string }).code;
      }
    }),
  );

  assert.equal(results.filter((result) => result === "acquired").length, 1);
  assert.equal(
    results.filter((result) => result === "RENDER_TARGET_LOCKED").length,
    11,
  );
});

test("the lock file records the target it belongs to", async (t) => {
  const root = await lockRoot(t);
  const lock = acquireRenderTargetLock("zz-track", "vertical-9x16", { root });
  const written = JSON.parse(await readFile(lock.file, "utf8"));

  assert.equal(written.slug, "zz-track");
  assert.equal(written.presetId, "vertical-9x16");
  assert.equal(written.hostname.length > 0, true);
  assert.equal(written.token, lock.token);
  assert.ok(Number.isFinite(Date.parse(written.createdAt)));
});

/* ------------------------------------------------------------------ *
 * The render manager's courtesy check
 * ------------------------------------------------------------------ */

/**
 * These use the project's real lock directory, because that is the one the
 * manager consults — it deliberately has no injection seam, so that production
 * code cannot be pointed somewhere harmless by accident. The lock is written
 * with this process's own pid, which is the simplest thing that genuinely looks
 * alive to the real liveness probe.
 */
const heldByALiveProcess = async (
  t: TestContext,
  slug: string,
  presetId: "youtube-16x9" | "vertical-9x16" | "square-1x1",
) => {
  const lock = acquireRenderTargetLock(slug, presetId, { jobId: "elsewhere" });
  t.after(() => lock.release());
  return lock;
};

test("a single render is refused while another process holds the target", async (t) => {
  const { managerWithWorkers } = await import("./managerHarness.mts");
  const { manager } = await managerWithWorkers(t);

  await heldByALiveProcess(t, "zz-lock-probe", "square-1x1");

  assert.throws(
    () => manager.startRender("zz-lock-probe", "square-1x1"),
    (error: Error & { code?: string }) => {
      assert.equal(error.code, "RENDER_TARGET_LOCKED");
      assert.match(error.message, /another process/);
      assert.match(error.message, /elsewhere/, "names the holding job");
      return true;
    },
  );

  // Nothing was queued, so the refusal really did stop a second render.
  assert.deepEqual(manager.listJobs(), []);

  // A different format of the same track is unaffected.
  assert.doesNotThrow(() =>
    manager.startRender("zz-lock-probe", "youtube-16x9"),
  );
});

test("a batch leaves out a locked target and reports it, queueing the rest", async (t) => {
  const { managerWithWorkers } = await import("./managerHarness.mts");
  const { manager } = await managerWithWorkers(t);

  await heldByALiveProcess(t, "zz-lock-batch", "square-1x1");

  const { batch, locked, skipped } = manager.startBatch([
    { slug: "zz-lock-batch", preset: "square-1x1" },
    { slug: "zz-lock-batch", preset: "youtube-16x9" },
  ]);

  // One contended format must not stop the others from queueing.
  assert.deepEqual(
    batch.jobs.map((job) => job.presetId),
    ["youtube-16x9"],
  );
  assert.deepEqual(locked, [
    { slug: "zz-lock-batch", preset: "square-1x1" },
  ]);
  assert.deepEqual(skipped, [], "locked is reported apart from queue skips");
});
