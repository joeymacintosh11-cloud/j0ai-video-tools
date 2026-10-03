import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { acquireAfterEffectsStagingLock } from "../adapters/after-effects/stagingLock.mts";

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
