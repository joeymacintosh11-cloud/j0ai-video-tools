import assert from "node:assert/strict";
import { fork } from "node:child_process";
import fs from "node:fs";
import { mkdtemp, readdir, rm, writeFile, readFile, unlink } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test, { type TestContext } from "node:test";
import { acquireRenderTargetLock, inspectRenderTargetLock, renderLockFile, releaseRenderTargetLock, withRenderTargetLock } from "../services/render/renderLock.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { fixture } from "./fixtures.mts";
const rootFor = async (t: TestContext) => {
  const root = await mkdtemp(path.join(tmpdir(), "toshi-lock-safety-"));
  t.after(() => rm(root, { recursive: true, force: true })); return root;
};
const contender = async (t: TestContext, root: string, slug = "probe") => {
  const child = fork(new URL("./lock-process.mts", import.meta.url), [slug, "square-1x1", root], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  await once(child, "message"); return child;
};
for (const stale of [false, true]) {
  test(`real processes: ${stale ? "simultaneous stale recovery" : "exclusive creation"} has one owner`, async (t) => {
    const root = await rootFor(t);
    if (stale) {
      const dead = await contender(t, root);
      const got = once(dead, "message"); dead.send("acquire"); await got;
      const exited = once(dead, "exit"); dead.kill("SIGKILL"); await exited;
    }
    const children = await Promise.all(Array.from({ length: 8 }, () => contender(t, root)));
    const replies = children.map((child) => once(child, "message"));
    children.forEach((child) => child.send("acquire"));
    const results = await Promise.all(replies);
    assert.equal(results.filter(([r]) => r.type === "acquired").length, 1);
    const index = results.findIndex(([r]) => r.type === "acquired");
    assert.equal(inspectRenderTargetLock("probe", "square-1x1", { root }).state, "held");
    const exited = once(children[index], "exit"); children[index].send("release"); await exited;
    assert.deepEqual(await readdir(root), []);
  });
}
test("displaced owner cannot release or commit through a successor", async (t) => {
  const root = await rootFor(t);
  const old = acquireRenderTargetLock("probe", "square-1x1", { root });
  await unlink(old.file); // Simulate external/offline displacement, never supported live release.
  const next = acquireRenderTargetLock("probe", "square-1x1", { root });
  const before = await readFile(next.file);
  assert.throws(() => old.commit(() => assert.fail("must not publish")), { code: "RENDER_TARGET_LOCKED" });
  old.release();
  assert.deepEqual(await readFile(next.file), before);
  assert.throws(() => releaseRenderTargetLock("probe", "square-1x1", { root }), { code: "RENDER_TARGET_LOCKED" });
  next.release(); assert.deepEqual(await readdir(root), []);
});
test("release after absence never removes a subsequently acquired owner", async (t) => {
  const root = await rootFor(t);
  const old = acquireRenderTargetLock("probe", "square-1x1", { root });
  await unlink(old.file); old.release();
  const next = acquireRenderTargetLock("probe", "square-1x1", { root });
  old.release(); next.assertOwned(); next.release();
  assert.deepEqual(await readdir(root), []);
});
test("publication after ownership loss preserves previous pair and successor", async (t) => {
  const f = await fixture(t);
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));
  const root = await rootFor(t);
  const inputs = { metadata: "a".repeat(64), cover: "b".repeat(64), audio: "c".repeat(64), preset: "d".repeat(64), visualizer: "e".repeat(64) };
  await publishExport(f.slug, "square-1x1", inputs, (file) => writeFile(file, "previous"));
  const old = acquireRenderTargetLock(f.slug, "square-1x1", { root });
  let next: ReturnType<typeof acquireRenderTargetLock> | undefined;
  await assert.rejects(() => publishExport(f.slug, "square-1x1", inputs, async (file) => {
    await writeFile(file, "replacement"); await unlink(old.file);
    next = acquireRenderTargetLock(f.slug, "square-1x1", { root });
  }, undefined, old), { code: "RENDER_TARGET_LOCKED" });
  old.release(); next!.assertOwned(); next!.release();
  assert.equal(await readFile(path.join(f.outputDir, "square-1x1.mp4"), "utf8"), "previous");
  assert.equal((await readdir(f.outputDir)).some((n) => n.startsWith(".render-")), false);
});
test("corrupt PID/target/host and abandoned guard fail closed", async (t) => {
  const root = await rootFor(t);
  const file = renderLockFile("probe", "square-1x1", root);
  const valid = { schemaVersion: 1, slug: "probe", presetId: "square-1x1", pid: process.pid, hostname: hostname(), createdAt: new Date().toISOString(), jobId: null, token: "test" };
  for (const patch of [{ pid: 0 }, { pid: -1 }, { pid: 2 ** 40 }, { slug: "other" }, { hostname: "" }, { hostname: "foreign-host" }]) {
    await writeFile(file, JSON.stringify({ ...valid, ...patch }));
    assert.throws(() => acquireRenderTargetLock("probe", "square-1x1", { root, isAlive: () => false }), { code: "RENDER_TARGET_LOCKED" });
  }
  await unlink(file); await writeFile(`${file}.guard`, "corrupt");
  assert.throws(() => acquireRenderTargetLock("probe", "square-1x1", { root }), { code: "RENDER_TARGET_LOCKED" });
  assert.equal(await readFile(`${file}.guard`, "utf8"), "corrupt");
});
test("failed lock metadata write cleans up only its own file and guard", async (t) => {
  const root = await rootFor(t);
  const original = fs.writeSync;
  let calls = 0;
  t.mock.method(fs, "writeSync", (...args: Parameters<typeof fs.writeSync>) => {
    if (++calls === 2) throw new Error("disk full");
    return original(...args);
  }); syncBuiltinESMExports();
  try { assert.throws(() => acquireRenderTargetLock("probe", "square-1x1", { root }), /disk full/); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.deepEqual(await readdir(root), []);
});
for (const message of ["worker failure", "renderMedia() got cancelled"]) {
  test(`${message} releases the lock and guard`, async (t) => {
    const root = await rootFor(t);
    await assert.rejects(() => withRenderTargetLock("probe", "square-1x1", async () => { throw new Error(message); }, { root }));
    assert.deepEqual(await readdir(root), []);
  });
}

test("manual recovery clears a guard left behind by a killed process", async (t) => {
  const root = await rootFor(t);
  const file = renderLockFile("probe", "square-1x1", root);
  const dead = { pid: 2147483646, hostname: hostname() };

  // What a process killed inside the short ownership section leaves behind: an
  // abandoned lock and the guard it was holding at the time.
  await writeFile(file, JSON.stringify({
    schemaVersion: 1, slug: "probe", presetId: "square-1x1",
    pid: dead.pid, hostname: dead.hostname,
    createdAt: new Date().toISOString(), jobId: null, token: "abandoned",
  }));
  await writeFile(`${file}.guard`, JSON.stringify({ ...dead, token: "abandoned" }));

  // Automatic acquisition never clears a guard: that is the one section where
  // ownership changes hands, and guessing there is what would admit two owners.
  assert.throws(() => acquireRenderTargetLock("probe", "square-1x1", { root }), {
    code: "RENDER_TARGET_LOCKED",
  });
  assert.equal(fs.existsSync(`${file}.guard`), true, "left for the operator");

  // The manual path may clear it, because nothing live can still hold it — and
  // without this the target would be unusable forever.
  assert.equal(releaseRenderTargetLock("probe", "square-1x1", { root }), true);
  assert.deepEqual(await readdir(root), []);

  const recovered = acquireRenderTargetLock("probe", "square-1x1", { root });
  recovered.release();
  assert.deepEqual(await readdir(root), []);
});

test("manual recovery refuses a guard a live process still holds", async (t) => {
  const root = await rootFor(t);
  const file = renderLockFile("probe", "square-1x1", root);

  // This process is unmistakably alive, so its guard must never be revoked.
  await writeFile(`${file}.guard`, JSON.stringify({
    pid: process.pid, hostname: hostname(), token: "live",
  }));

  assert.throws(() => releaseRenderTargetLock("probe", "square-1x1", { root }), {
    code: "RENDER_TARGET_LOCKED",
  });
  assert.equal(await readFile(`${file}.guard`, "utf8").then(JSON.parse).then((o) => o.token), "live");
});

test("a lock path cannot be steered outside the lock root", async (t) => {
  const root = await rootFor(t);

  for (const slug of ["../../etc/passwd", "..", "/absolute", "with/slash", ""]) {
    assert.throws(() => renderLockFile(slug, "square-1x1", root), {
      code: "INVALID_SLUG",
    });
  }
  assert.throws(() => renderLockFile("probe", "../escape" as never, root), {
    code: "INVALID_PRESET",
  });

  const file = renderLockFile("probe", "square-1x1", root);
  assert.equal(path.dirname(file), path.resolve(root));
  assert.equal(path.basename(file), "probe__square-1x1.lock");
});

test("a finished render is not reported as failed because a lock lingers", async (t) => {
  const root = await rootFor(t);
  const file = renderLockFile("probe", "square-1x1", root);

  // A guard held by a live foreign process makes release impossible. The work
  // still succeeded, so the caller must get its result rather than an error.
  const result = await withRenderTargetLock(
    "probe",
    "square-1x1",
    async () => {
      await writeFile(`${file}.guard`, JSON.stringify({
        pid: process.pid, hostname: hostname(), token: "blocking",
      }));
      return "published";
    },
    { root },
  );

  assert.equal(result, "published");
  // The lock survives, which is recoverable; losing the result would not be.
  assert.equal(inspectRenderTargetLock("probe", "square-1x1", { root }).state, "held");
});
