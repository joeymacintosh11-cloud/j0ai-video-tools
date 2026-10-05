import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { acquireAfterEffectsStagingLock, GUARD_WAIT_MS } from "../adapters/after-effects/stagingLock.mts";

const STAGING_LOCK = fileURLToPath(new URL("../adapters/after-effects/stagingLock.mts", import.meta.url));

test("AE staging excludes overlapping sessions, including path aliases, and releases idempotently", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ae-serial-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const staging = path.join(dir, "staging");
  const alias = path.join(dir, "alias");
  await mkdir(staging);
  await symlink(staging, alias);
  const release = acquireAfterEffectsStagingLock(path.join(staging, "data.json"));
  assert.throws(() => acquireAfterEffectsStagingLock(path.join(alias, "other-data.json")), { code: "RENDER_TARGET_LOCKED" });
  release(); release();
  const next = acquireAfterEffectsStagingLock(path.join(alias, "data.json"));
  next();
});

test("an interrupted or unreadable AE lock is never automatically reclaimed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ae-interrupted-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, ".toshi-ae-render.lock"));
  assert.throws(() => acquireAfterEffectsStagingLock(path.join(dir, "data.json")), (error: unknown) => {
    assert.match((error as Error).message, /verify aerender has stopped/);
    return (error as { code: string }).code === "RENDER_TARGET_LOCKED";
  });
});

test("another process's refused acquisitions never fail the live owner's ownership updates or release", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ae-guard-contention-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const data = path.join(dir, "data.json");
  const lock = acquireAfterEffectsStagingLock(data);
  // A second session retrying as fast as it can: each refused attempt holds
  // the ownership guard for a moment, as a real competing render would.
  const contender = spawn(process.execPath, ["--input-type=module", "-e", `
    import { acquireAfterEffectsStagingLock } from ${JSON.stringify(STAGING_LOCK)};
    let refused = 0, acquired = 0;
    for (const end = Date.now() + 800; Date.now() < end;) {
      try { acquireAfterEffectsStagingLock(${JSON.stringify(data)})(); acquired++; } catch { refused++; }
    }
    console.log(JSON.stringify({ refused, acquired }));
  `], { stdio: ["ignore", "pipe", "inherit"] });
  let output = "";
  contender.stdout.on("data", (bytes) => { output += String(bytes); });
  const exited = new Promise((done) => contender.once("close", done));
  await new Promise((done) => setTimeout(done, 150));
  const failures: unknown[] = [];
  for (const end = Date.now() + 400; Date.now() < end;) {
    try { lock.update({ phase: "rendering", safeToDelete: false }); } catch (error) { failures.push(error); }
    await new Promise((done) => setImmediate(done));
  }
  await exited;
  assert.deepEqual(failures, []);
  const result = JSON.parse(output) as { refused: number; acquired: number };
  assert.ok(result.refused > 0, "the contender really competed");
  assert.equal(result.acquired, 0, "the live lock was never taken over");
  lock();
  assert.equal(existsSync(path.join(dir, ".toshi-ae-render.lock")), false);
});

test("an ownership guard that stays held is still treated as crashed: the update fails closed and nothing is removed", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "ae-guard-crashed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const lock = acquireAfterEffectsStagingLock(path.join(dir, "data.json"));
  const folder = path.join(dir, ".toshi-ae-render.lock");
  await mkdir(`${folder}.guard`);
  const started = Date.now();
  assert.throws(() => lock.update({ phase: "ready" }), { code: "RENDER_TARGET_LOCKED" });
  assert.ok(Date.now() - started >= GUARD_WAIT_MS, "waited for the guard before giving up");
  assert.throws(() => lock(), { code: "RENDER_TARGET_LOCKED" });
  assert.equal(existsSync(`${folder}.guard`), true, "a crashed guard is left for inspection");
  assert.equal(existsSync(folder), true, "the lock is not released past a held guard");
});
