import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { tmpdir, hostname } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import {
  inspectAfterEffectsWorkspace as inspect,
  maintainAfterEffectsWorkspace as maintain,
  prunePreparedCache,
  automationDirectory,
} from "../adapters/after-effects/workspace.mts";
import { readAfterEffectsConfig } from "../adapters/after-effects/afterEffectsConfig.mts";
import {
  acquireAfterEffectsStagingLock,
  newWorkspaceOwner,
  writeWorkspaceOwner,
  type WorkspaceOwner,
} from "../adapters/after-effects/stagingLock.mts";

const setup = (t: TestContext) => {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(tmpdir(), "ae-workspace-test-")),
  );
  const project = path.join(dir, "base.aep");
  fs.writeFileSync(project, "RIFX synthetic base");
  const file = path.join(dir, "config.json");
  fs.writeFileSync(
    file,
    JSON.stringify({
      project,
      composition: "Test comp",
      applicationBundleId: `test.workspace.${path.basename(dir)}`,
      templatePreparation: "auto",
    }),
  );
  const config = readAfterEffectsConfig(file);
  fs.mkdirSync(config.workingDirectory);
  t.after(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(automationDirectory(config.applicationBundleId), {
      recursive: true,
      force: true,
    });
  });
  const deps = {
    isAlive: (pid: number) => pid === process.pid,
    host: hostname(),
    maxEntries: 2,
  };
  const owner = (changes: Partial<WorkspaceOwner> = {}): WorkspaceOwner => ({
    ...newWorkspaceOwner(),
    pid: 999999,
    phase: "completed",
    safeToDelete: true,
    ...changes,
  });
  const lock = (
    changes: Partial<WorkspaceOwner> = {},
    folder = path.join(dir, ".toshi-ae-render.lock"),
  ) => {
    fs.mkdirSync(folder, { recursive: true });
    writeWorkspaceOwner(path.join(folder, "owner.json"), owner(changes));
    return folder;
  };
  const run = (
    changes: Partial<WorkspaceOwner> = {},
    status:
      | "valid"
      | "wrong-token"
      | "malformed"
      | "wrong-identity"
      | "absent" = "valid",
  ) => {
    const token = randomUUID(),
      folder = path.join(config.workingDirectory, `run-${token}`);
    fs.mkdirSync(folder);
    const job = {
      token,
      preparedProject: path.join(folder, "prepared.partial.aep"),
      statusFile: path.join(folder, `status-${token}.json`),
      marker: "text-marker",
      identity: "template-identity",
      composition: "Test comp",
      prepVersion: "v1",
    };
    writeWorkspaceOwner(
      path.join(folder, "owner.json"),
      owner({ runToken: token, runDirectory: folder, ...changes }),
    );
    fs.writeFileSync(path.join(folder, "job.json"), JSON.stringify(job));
    fs.writeFileSync(job.preparedProject, "RIFX incomplete");
    if (status !== "absent")
      fs.writeFileSync(
        job.statusFile,
        status === "malformed"
          ? "{"
          : JSON.stringify({
              ...job,
              success: true,
              ...(status === "wrong-token" ? { token: randomUUID() } : {}),
              ...(status === "wrong-identity" ? { identity: "wrong" } : {}),
            }),
      );
    return folder;
  };
  const cache = (n: number) => {
    const identity = `toshi-prepared-${String(n).padStart(64, "0")}`,
      file = path.join(config.workingDirectory, `${identity}.aep`);
    const bytes = Buffer.from(`RIFX validated ${n}`);
    fs.writeFileSync(file, bytes);
    fs.writeFileSync(
      `${file}.json`,
      JSON.stringify({
        identity,
        baseHash: "a".repeat(64),
        projectHash: createHash("sha256").update(bytes).digest("hex"),
        marker: "marker",
        composition: "Test comp",
        prepVersion: "v1",
        lastUsedAt: new Date(100000 + n * 1000).toISOString(),
      }),
    );
    return file;
  };
  return { dir, project, file, config, deps, owner, lock, run, cache };
};

test("live owner and live child locks survive inspection and cleanup regardless of age", (t) => {
  const c = setup(t);
  const lock = c.lock({ pid: process.pid, createdAt: "2000-01-01T00:00:00Z" });
  assert.equal(inspect(c.config, c.deps).activeJobs, 1);
  maintain(c.config, { dryRun: false, prune: true }, c.deps);
  assert.ok(fs.existsSync(lock));
  fs.rmSync(lock, { recursive: true });
  c.lock({ childPid: process.pid });
  assert.equal(inspect(c.config, c.deps).activeJobs, 1);
  assert.equal(
    maintain(c.config, { dryRun: true, prune: true }, c.deps).candidates.length,
    0,
  );
});

test("dead safe owner is recoverable; old rendering/preparing state alone is not", (t) => {
  const c = setup(t);
  const lock = c.lock();
  assert.equal(inspect(c.config, c.deps).orphanedLocks, 1);
  assert.equal(inspect(c.config, c.deps).recoverable, 1);
  maintain(c.config, { dryRun: false, prune: false }, c.deps);
  assert.ok(!fs.existsSync(lock));
  c.lock({ phase: "rendering", safeToDelete: false });
  assert.equal(inspect(c.config, c.deps).recoverable, 0);
  maintain(c.config, { dryRun: false, prune: true }, c.deps);
  assert.ok(fs.existsSync(lock));
});

for (const variant of ["legacy", "malformed", "foreign", "guard"] as const)
  test(`${variant} ownership requires manual inspection`, (t) => {
    const c = setup(t);
    const lock = c.lock(
      variant === "foreign" ? { hostname: "another-host" } : {},
    );
    if (variant === "legacy")
      fs.writeFileSync(
        path.join(lock, "owner.json"),
        JSON.stringify({ pid: 999999, token: "old" }),
      );
    if (variant === "malformed")
      fs.writeFileSync(path.join(lock, "owner.json"), "{");
    if (variant === "guard") fs.mkdirSync(`${lock}.guard`);
    assert.ok(inspect(c.config, c.deps).manual > 0);
    maintain(c.config, { dryRun: false, prune: true }, c.deps);
    assert.ok(fs.existsSync(lock));
  });

test("completed run cleanup removes job/status/partial as a set, matches dry-run and is idempotent", (t) => {
  const c = setup(t),
    run = c.run();
  const before = fs.readFileSync(c.project);
  const dry = maintain(c.config, { dryRun: true, prune: false }, c.deps);
  assert.equal(dry.inspection.abandonedPartials, 1);
  assert.deepEqual(
    dry.candidates.map((i) => i.path),
    [run],
  );
  assert.ok(fs.existsSync(run));
  const real = maintain(c.config, { dryRun: false, prune: false }, c.deps);
  assert.deepEqual(
    real.candidates.map((i) => i.path),
    dry.candidates.map((i) => i.path),
  );
  assert.deepEqual(real.removed, [run]);
  assert.deepEqual(real.failures, []);
  assert.deepEqual(fs.readFileSync(c.project), before);
  assert.deepEqual(
    maintain(c.config, { dryRun: false, prune: false }, c.deps).removed,
    [],
  );
});

for (const status of [
  "valid",
  "wrong-token",
  "wrong-identity",
  "malformed",
  "absent",
] as const)
  test(`interrupted preparation ${status} status: only matching terminal proof authorizes cleanup`, (t) => {
    const c = setup(t),
      run = c.run({ phase: "uncertain", safeToDelete: false }, status);
    const result = maintain(c.config, { dryRun: false, prune: false }, c.deps);
    assert.equal(fs.existsSync(run), status !== "valid");
    assert.equal(result.removed.includes(run), status === "valid");
    assert.equal(
      fs
        .readdirSync(c.config.workingDirectory)
        .some((n) => n.startsWith("toshi-prepared-")),
      false,
    );
  });

test("wrong run identity, unknown run files and symlinks are retained", (t) => {
  const c = setup(t);
  const wrong = c.run({ runToken: "wrong" });
  const unknown = c.run();
  fs.writeFileSync(path.join(unknown, "personal.txt"), "keep");
  const linked = c.run();
  fs.symlinkSync(c.project, path.join(linked, "base.aep"));
  maintain(c.config, { dryRun: false, prune: false }, c.deps);
  for (const file of [wrong, unknown, linked]) assert.ok(fs.existsSync(file));
});

test("valid cache survives safe cleanup; invalid cache/provenance and unknown artifacts stay manual", (t) => {
  const c = setup(t),
    valid = c.cache(1),
    bad = c.cache(2);
  fs.writeFileSync(bad, "corrupt");
  const orphan = c.cache(3);
  fs.unlinkSync(orphan);
  const unknown = path.join(c.config.workingDirectory, "personal.txt");
  fs.writeFileSync(unknown, "keep");
  const i = inspect(c.config, c.deps);
  assert.equal(i.cacheEntries, 1);
  assert.equal(
    i.artifacts.filter((i) => i.reason === "cache_entry_invalid").length,
    2,
  );
  maintain(c.config, { dryRun: false, prune: false }, c.deps);
  for (const file of [valid, bad, `${orphan}.json`, unknown])
    assert.ok(fs.existsSync(file));
});

test("retention removes oldest complete pairs, reports exact dry-run candidates and preserves base/metadata", (t) => {
  const c = setup(t),
    old = c.cache(1),
    middle = c.cache(2),
    latest = c.cache(3);
  const metadata = path.join(c.dir, "metadata.json");
  fs.writeFileSync(metadata, '{"renderer":"after-effects"}');
  const before = fs.readFileSync(c.project);
  const dry = maintain(c.config, { dryRun: true, prune: true }, c.deps);
  assert.deepEqual(
    dry.candidates.map((i) => i.path),
    [old],
  );
  assert.ok(fs.existsSync(old));
  const result = maintain(c.config, { dryRun: false, prune: true }, c.deps);
  assert.deepEqual(result.removed, [old, `${old}.json`]);
  assert.deepEqual(result.failures, []);
  assert.ok(fs.existsSync(middle) && fs.existsSync(latest));
  assert.deepEqual(fs.readFileSync(c.project), before);
  assert.equal(
    fs.readFileSync(metadata, "utf8"),
    '{"renderer":"after-effects"}',
  );
});

test("active workspace prevents maintenance pruning; lock owner retention preserves current older copy", (t) => {
  const c = setup(t),
    old = c.cache(1),
    middle = c.cache(2),
    latest = c.cache(3);
  const lock = acquireAfterEffectsStagingLock(
    path.join(c.config.workingDirectory, "workspace.json"),
    ".toshi-ae-workspace.lock",
  );
  try {
    assert.equal(
      maintain(c.config, { dryRun: true, prune: true }, c.deps).candidates
        .length,
      0,
    );
    assert.throws(
      () => prunePreparedCache(c.config, null, "not-owner", 2),
      /ownership/,
    );
    const result = prunePreparedCache(c.config, old, lock.token, 2);
    assert.deepEqual(result.removed, [middle, `${middle}.json`]);
    assert.ok(fs.existsSync(old) && fs.existsSync(latest));
  } finally {
    lock();
  }
});

test("second pair rename failure rolls back the project and reports cleanup_failed", (t) => {
  const c = setup(t),
    old = c.cache(1);
  c.cache(2);
  c.cache(3);
  const original = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (String(from) === `${old}.json`)
      throw new Error("injected provenance failure");
    return original(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    const r = maintain(c.config, { dryRun: false, prune: true }, c.deps);
    assert.equal(r.failures[0]?.reason, "cleanup_failed");
    assert.ok(fs.existsSync(old) && fs.existsSync(`${old}.json`));
  } finally {
    fs.renameSync = original;
    syncBuiltinESMExports();
  }
  assert.equal(inspect(c.config, c.deps).cacheEntries, 3);
});

test("cleanup revalidates owner before deletion rather than trusting the inspection snapshot", (t) => {
  const c = setup(t),
    lock = c.lock();
  let reads = 0;
  const deps = { ...c.deps, isAlive: () => ++reads > 1 };
  const result = maintain(c.config, { dryRun: false, prune: false }, deps);
  assert.ok(fs.existsSync(lock));
  assert.equal(result.failures[0]?.reason, "cleanup_failed");
});

test("hard-link aliases of configured base are never retention candidates", (t) => {
  const c = setup(t),
    alias = c.cache(1);
  fs.unlinkSync(alias);
  fs.linkSync(c.project, alias);
  const meta = JSON.parse(fs.readFileSync(`${alias}.json`, "utf8"));
  meta.projectHash = createHash("sha256")
    .update(fs.readFileSync(c.project))
    .digest("hex");
  fs.writeFileSync(`${alias}.json`, JSON.stringify(meta));
  assert.equal(
    maintain(
      c.config,
      { dryRun: true, prune: true },
      { ...c.deps, maxEntries: 0 },
    ).candidates.length,
    0,
  );
  maintain(
    c.config,
    { dryRun: false, prune: true },
    { ...c.deps, maxEntries: 0 },
  );
  assert.ok(fs.existsSync(alias));
  assert.ok(fs.existsSync(c.project));
});

test("completed eviction quarantine is recoverable; uncertain eviction remains evidence", (t) => {
  const c = setup(t);
  const folders = ["completed", "evicting"].map((phase) => {
    const folder = path.join(
      c.config.workingDirectory,
      `evict-${randomUUID()}`,
    );
    fs.mkdirSync(folder);
    writeWorkspaceOwner(
      path.join(folder, "owner.json"),
      c.owner({ phase, safeToDelete: phase === "completed" }),
    );
    fs.writeFileSync(path.join(folder, "project.aep"), "RIFX trash");
    return folder;
  });
  maintain(c.config, { dryRun: false, prune: false }, c.deps);
  assert.ok(!fs.existsSync(folders[0]));
  assert.ok(fs.existsSync(folders[1]));
});

test("maintenance CLI defaults to read-only/dry-run and requires explicit apply", (t) => {
  const c = setup(t),
    run = c.run();
  const script = fileURLToPath(
    new URL("../scripts/ae-workspace.mts", import.meta.url),
  );
  const cli = (...args: string[]) =>
    JSON.parse(
      execFileSync(process.execPath, [script, ...args, "--json"], {
        env: { ...process.env, TOSHI_AE_CONFIG: c.file },
        encoding: "utf8",
      }),
    );
  assert.equal(cli().abandonedPartials, 1);
  assert.ok(fs.existsSync(run));
  assert.equal(cli("--cleanup").dryRun, true);
  assert.ok(fs.existsSync(run));
  assert.deepEqual(cli("--cleanup", "--apply").removed, [run]);
  assert.ok(!fs.existsSync(run));
});

test("multiple engine locks for the same owner count as one active job", (t) => {
  const c = setup(t);
  c.lock({ pid: process.pid, trackIdentity: "track-a" });
  c.lock(
    { pid: process.pid, trackIdentity: "track-a" },
    path.join(c.config.workingDirectory, ".toshi-ae-workspace.lock"),
  );
  assert.equal(inspect(c.config, c.deps).activeJobs, 1);
});

test("cache dry-run names provenance and flat Adobe logs exactly", (t) => {
  const c = setup(t),
    cache = c.cache(1);
  const logs = `${cache} Logs`;
  fs.mkdirSync(logs);
  fs.writeFileSync(path.join(logs, "render.log"), "temporary");
  assert.equal(
    inspect(c.config, c.deps).manual,
    0,
    "ordinary logs associated with a valid cache do not imply recovery trouble",
  );
  const dry = maintain(
    c.config,
    { dryRun: true, prune: true },
    { ...c.deps, maxEntries: 0 },
  );
  assert.deepEqual(dry.candidates[0].relatedPaths, [`${cache}.json`, logs]);
  const result = maintain(
    c.config,
    { dryRun: false, prune: true },
    { ...c.deps, maxEntries: 0 },
  );
  assert.deepEqual(result.removed, [cache, `${cache}.json`, logs]);
});

test("failed eviction rollback retains quarantine as manual evidence", (t) => {
  const c = setup(t),
    cache = c.cache(1);
  const rename = fs.renameSync;
  fs.renameSync = ((from, to) => {
    if (
      String(from) === `${cache}.json` ||
      String(from).endsWith("project.aep")
    )
      throw new Error("injected rollback failure");
    return rename(from, to);
  }) as typeof fs.renameSync;
  syncBuiltinESMExports();
  try {
    const result = maintain(
      c.config,
      { dryRun: false, prune: true },
      { ...c.deps, maxEntries: 0 },
    );
    assert.equal(result.failures.length, 1);
  } finally {
    fs.renameSync = rename;
    syncBuiltinESMExports();
  }
  const quarantine = inspect(c.config, c.deps).artifacts.find((i) =>
    path.basename(i.path).startsWith("evict-"),
  );
  assert.ok(quarantine);
  assert.equal(quarantine.safe, false);
});

test("applying a changed preview deletes nothing and requests a fresh preview", (t) => {
  const c = setup(t),
    first = c.run();
  const preview = maintain(c.config, { dryRun: true, prune: false }, c.deps);
  const second = c.run();
  const result = maintain(
    c.config,
    {
      dryRun: false,
      prune: false,
      expectedPaths: preview.candidates.flatMap((i) => [
        i.path,
        ...(i.relatedPaths ?? []),
      ]),
    },
    c.deps,
  );
  assert.equal(result.failures[0]?.reason, "cleanup_failed");
  assert.deepEqual(result.removed, []);
  assert.ok(fs.existsSync(first) && fs.existsSync(second));
});

test("unknown files inside a lock prevent recursive recovery deletion", (t) => {
  const c = setup(t),
    lock = c.lock();
  fs.writeFileSync(path.join(lock, "personal.txt"), "keep");
  assert.equal(inspect(c.config, c.deps).recoverable, 0);
  maintain(c.config, { dryRun: false, prune: false }, c.deps);
  assert.ok(fs.existsSync(lock));
});

test("malformed interrupted status is reported explicitly while the partial remains manual", (t) => {
  const c = setup(t),
    run = c.run({ phase: "uncertain", safeToDelete: false }, "malformed");
  const state = inspect(c.config, c.deps);
  assert.equal(
    state.artifacts.find((i) => i.path === run)?.reason,
    "malformed_status",
  );
  assert.equal(state.abandonedPartials, 1);
  assert.equal(state.recoverable, 0);
});

test("explicit retention cannot evict an unpreviewed entry if cache ordering changed", (t) => {
  const c = setup(t),
    first = c.cache(1),
    second = c.cache(2);
  c.cache(3);
  const lock = acquireAfterEffectsStagingLock(
    path.join(c.config.workingDirectory, "workspace.json"),
    ".toshi-ae-workspace.lock",
  );
  try {
    const result = prunePreparedCache(
      c.config,
      null,
      lock.token,
      1,
      new Set([first]),
    );
    assert.deepEqual(result.removed, [first, `${first}.json`]);
    assert.ok(fs.existsSync(second));
  } finally {
    lock();
  }
});

test("even the workspace owner cannot prune during an active child or omit its resolved copy", (t) => {
  const c = setup(t),
    current = c.cache(1);
  c.cache(2);
  c.cache(3);
  const lock = acquireAfterEffectsStagingLock(
    path.join(c.config.workingDirectory, "workspace.json"),
    ".toshi-ae-workspace.lock",
  );
  try {
    lock.update({
      phase: "rendering",
      safeToDelete: false,
      childPid: process.pid,
      preparedProject: current,
    });
    assert.throws(
      () => prunePreparedCache(c.config, null, lock.token, 0),
      /confirmed idle ownership/,
    );
    assert.ok(fs.existsSync(current));
    lock.update({ phase: "rendered", safeToDelete: true, childPid: null });
    prunePreparedCache(c.config, null, lock.token, 1);
    assert.ok(fs.existsSync(current));
  } finally {
    lock();
  }
});

test("dangling lock and guard symlinks are reported as manual and never mistaken for absence", (t) => {
  const c = setup(t);
  const lock = path.join(c.dir, ".toshi-ae-render.lock");
  fs.symlinkSync(path.join(c.dir, "missing"), lock);
  fs.symlinkSync(path.join(c.dir, "missing-guard"), `${lock}.guard`);
  const state = inspect(c.config, c.deps);
  assert.equal(state.manual, 2);
  assert.equal(state.recoverable, 0);
  maintain(c.config, { dryRun: false, prune: true }, c.deps);
  assert.ok(fs.lstatSync(lock).isSymbolicLink());
  assert.ok(fs.lstatSync(`${lock}.guard`).isSymbolicLink());
});

test("known atomic staging leftovers are reported without sweeping unrelated files or staged inputs", (t) => {
  const c = setup(t);
  const leftover = path.join(c.dir, "toshi-cover.png.tmp-999999"),
    input = path.join(c.dir, "toshi-cover.png"),
    unrelated = path.join(c.dir, "personal.tmp-999999");
  for (const file of [leftover, input, unrelated])
    fs.writeFileSync(file, "keep");
  const state = inspect(c.config, c.deps);
  assert.equal(
    state.artifacts.find((i) => i.path === leftover)?.reason,
    "uncertain_owner",
  );
  assert.ok(
    !state.artifacts.some((i) => i.path === input || i.path === unrelated),
  );
  maintain(c.config, { dryRun: false, prune: true }, c.deps);
  for (const file of [leftover, input, unrelated])
    assert.ok(fs.existsSync(file));
});
