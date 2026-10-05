import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import type {
  RendererWorkspace,
  WorkspaceArtifact,
  WorkspaceInspection,
  WorkspaceMaintenance,
} from "../../core/ports/rendererWorkspace.ts";
import { fileContentHash } from "../../services/tracks/exportManifest.ts";
import {
  readAfterEffectsConfig,
  type AfterEffectsConfig,
} from "./afterEffectsConfig.mts";
import { STAGED_ASSET_NAMES } from "./templateContract.mts";
import {
  validatePreparationStatus,
  type PreparationJob,
} from "./afterEffectsScripting.mts";
import {
  acquireAfterEffectsStagingLock,
  newWorkspaceOwner,
  processIsAlive,
  readWorkspaceOwner,
  withWorkspaceLockGuard,
  writeWorkspaceOwner,
  type WorkspaceOwner,
} from "./stagingLock.mts";

export const CACHE_MAX_ENTRIES = 20;
export const automationDirectory = (bundle: string): string =>
  path.join(
    tmpdir(),
    `toshi-ae-automation-${createHash("sha256").update(bundle).digest("hex").slice(0, 16)}`,
  );
const CACHE_NAME = /^toshi-prepared-[a-f0-9]{64}\.aep$/;
const RUN_NAME = /^run-[a-f0-9-]{36}$/;
const SAFE_PHASES = new Set(["staging", "ready", "rendered", "completed"]);
export type WorkspaceDeps = {
  isAlive: (pid: number) => boolean;
  host: string;
  maxEntries: number;
};
const defaults: WorkspaceDeps = {
  isAlive: processIsAlive,
  host: hostname(),
  maxEntries: CACHE_MAX_ENTRIES,
};
const present = (file: string): boolean => {
  try {
    lstatSync(file);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
};
const regular = (file: string) => {
  try {
    return lstatSync(file).isFile();
  } catch {
    return false;
  }
};
const directory = (file: string) => {
  try {
    return lstatSync(file).isDirectory();
  } catch {
    return false;
  }
};
const children = (folder: string): string[] => {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
};
const bytes = (file: string): number => {
  try {
    return lstatSync(file).size;
  } catch {
    return 0;
  }
};
const stamp = (file: string): string | null => {
  try {
    return lstatSync(file).mtime.toISOString();
  } catch {
    return null;
  }
};
const diskIdentity = (file: string): string => {
  const s = lstatSync(file);
  return [s.dev, s.ino, s.size, s.mtimeMs, s.ctimeMs].join(":");
};
const artifact = (
  file: string,
  kind: WorkspaceArtifact["kind"],
  reason: WorkspaceArtifact["reason"],
  safe: boolean,
  details: string,
  size = bytes(file),
  date = stamp(file),
): WorkspaceArtifact => ({
  path: file,
  kind,
  reason,
  safe,
  details,
  bytes: size,
  createdAt: date,
});

const terminalProof = (owner: WorkspaceOwner, working: string): boolean => {
  try {
    const run = owner.runDirectory;
    if (
      !run ||
      path.dirname(run) !== working ||
      !RUN_NAME.test(path.basename(run)) ||
      !directory(run)
    )
      return false;
    const jobFile = path.join(run, "job.json");
    if (!regular(jobFile)) return false;
    const job = JSON.parse(readFileSync(jobFile, "utf8")) as PreparationJob;
    if (
      !["token", "marker", "identity", "composition", "prepVersion"].every(
        (key) =>
          typeof job[key as keyof PreparationJob] === "string" &&
          job[key as keyof PreparationJob] !== "",
      ) ||
      job.token !== owner.runToken ||
      path.basename(run) !== `run-${job.token}` ||
      job.preparedProject !== path.join(run, "prepared.partial.aep") ||
      job.statusFile !== path.join(run, `status-${job.token}.json`) ||
      !regular(job.statusFile)
    )
      return false;
    validatePreparationStatus(
      JSON.parse(readFileSync(job.statusFile, "utf8")),
      job,
    );
    return true;
  } catch {
    return false;
  }
};
const ownerState = (
  owner: WorkspaceOwner | null,
  working: string,
  deps: WorkspaceDeps,
): { reason: WorkspaceArtifact["reason"]; safe: boolean } => {
  if (!owner || owner.hostname !== deps.host)
    return { reason: "uncertain_owner", safe: false };
  if (
    deps.isAlive(owner.pid) ||
    (owner.childPid !== null && deps.isAlive(owner.childPid))
  )
    return { reason: "lock_owner_alive", safe: false };
  const safe =
    (owner.safeToDelete && SAFE_PHASES.has(owner.phase)) ||
    (["preparing", "uncertain"].includes(owner.phase) &&
      terminalProof(owner, working));
  return { reason: "lock_owner_missing", safe };
};
const noLinks = (folder: string): boolean => {
  try {
    return readdirSync(folder).every((name) =>
      regular(path.join(folder, name)),
    );
  } catch {
    return false;
  }
};
const lockFiles = (folder: string): boolean =>
  noLinks(folder) &&
  children(folder).every((name) =>
    /^owner\.json(?:\.tmp-[a-f0-9-]{36})?$/.test(name),
  );
const scopedRun = (owner: WorkspaceOwner | null, folder: string): boolean =>
  !!owner &&
  owner.runDirectory === folder &&
  path.basename(folder) === `run-${owner.runToken}`;
const runFiles = (folder: string): boolean =>
  noLinks(folder) &&
  children(folder).every((name) =>
    /^(?:owner\.json(?:\.tmp-[a-f0-9-]{36})?|job\.json|prepare\.jsx|base\.aepx?|prepared\.partial\.aep|provenance\.partial\.json|cancel|status-[a-f0-9-]{36}\.json(?:\.tmp)?)$/.test(
      name,
    ),
  );
const validCache = (project: string): boolean => {
  try {
    if (!regular(project) || !regular(`${project}.json`)) return false;
    const meta = JSON.parse(readFileSync(`${project}.json`, "utf8"));
    if (
      meta.identity !== path.basename(project, ".aep") ||
      !/^[a-f0-9]{64}$/.test(meta.baseHash) ||
      !/^[a-f0-9]{64}$/.test(meta.projectHash) ||
      typeof meta.marker !== "string" ||
      typeof meta.composition !== "string" ||
      typeof meta.prepVersion !== "string"
    )
      return false;
    const fd = openSync(project, "r");
    try {
      const header = Buffer.alloc(4);
      readSync(fd, header, 0, 4, 0);
      if (header.toString() !== "RIFX") return false;
    } finally {
      closeSync(fd);
    }
    return fileContentHash(project) === meta.projectHash;
  } catch {
    return false;
  }
};
const roots = (config: AfterEffectsConfig) => {
  const working = existsSync(config.workingDirectory)
    ? realpathSync(config.workingDirectory)
    : path.resolve(config.workingDirectory);
  if (present(working) && !directory(working))
    throw new Error(
      `AE workspace is not a readable directory: ${working}; inspect the configured path before recovery.`,
    );
  const staging = realpathSync(path.dirname(config.dataFile));
  return {
    working,
    staging,
    locks: [
      path.join(staging, ".toshi-ae-render.lock"),
      path.join(working, ".toshi-ae-workspace.lock"),
      path.join(
        automationDirectory(config.applicationBundleId),
        ".toshi-ae-render.lock",
      ),
    ],
  };
};
const baseProtected = (file: string, base: string): boolean => {
  // Never remove a base-containing directory, a base path, or a hard-link alias.
  const canonical = realpathSync(base);
  if (canonical === file || canonical.startsWith(`${file}${path.sep}`))
    return true;
  try {
    const a = lstatSync(file),
      b = lstatSync(canonical);
    return a.dev === b.dev && a.ino === b.ino;
  } catch {
    return false;
  }
};
export const inspectAfterEffectsWorkspace = (
  config: AfterEffectsConfig,
  overrides: Partial<WorkspaceDeps> = {},
): WorkspaceInspection => {
  const deps = { ...defaults, ...overrides },
    { working, staging, locks } = roots(config);
  const items: WorkspaceArtifact[] = [];
  let abandonedPartials = 0;
  for (const lock of locks) {
    if (present(lock) || present(`${lock}.guard`)) {
      const owner = directory(lock)
        ? readWorkspaceOwner(path.join(lock, "owner.json"))
        : null;
      const state = ownerState(owner, working, deps);
      items.push(
        artifact(
          lock,
          "lock",
          state.reason,
          state.safe &&
            directory(lock) &&
            lockFiles(lock) &&
            !present(`${lock}.guard`),
          owner
            ? `Owner ${owner.pid} on ${owner.hostname}; phase ${owner.phase}. Dead owner alone is not completion proof.`
            : "Legacy/malformed ownership; manual inspection required.",
        ),
      );
    }
    if (present(`${lock}.guard`))
      items.push(
        artifact(
          `${lock}.guard`,
          "unknown",
          "recovery_required",
          false,
          "Interrupted ownership mutation guard; inspect manually.",
        ),
      );
  }
  // Recognise only our atomic staging filenames; filenames/PIDs alone do not
  // establish ownership, so crash leftovers without a run token stay manual.
  for (const name of children(staging)) {
    const match = /^(.*)\.tmp-(\d+)$/.exec(name);
    if (
      !match ||
      (match[1] !== path.basename(config.dataFile) &&
        !Object.values(STAGED_ASSET_NAMES).includes(
          path.parse(match[1])
            .name as (typeof STAGED_ASSET_NAMES)[keyof typeof STAGED_ASSET_NAMES],
        ))
    )
      continue;
    const file = path.join(staging, name);
    items.push(
      artifact(
        file,
        "temporary",
        "uncertain_owner",
        false,
        `Atomic staging leftover; filename suggests PID ${match[2]}, but no run-token proof. Inspect manually.`,
      ),
    );
  }
  const unsafeLocks = items.some((i) => i.kind === "lock" && !i.safe);
  for (const name of children(working)) {
    const file = path.join(working, name);
    if (items.some((item) => item.path === file)) continue;
    if (
      name === ".toshi-ae-workspace.lock" ||
      name === ".toshi-ae-workspace.lock.guard"
    )
      continue;
    if (RUN_NAME.test(name) && directory(file)) {
      const owner = readWorkspaceOwner(path.join(file, "owner.json")),
        state = ownerState(owner, working, deps);
      const partial = existsSync(path.join(file, "prepared.partial.aep"));
      if (partial && state.reason !== "lock_owner_alive") abandonedPartials++;
      items.push({
        ...artifact(
          file,
          "run",
          state.reason === "lock_owner_alive"
            ? state.reason
            : owner &&
                ["preparing", "uncertain"].includes(owner.phase) &&
                children(file).some((name) => /^status-.*\.json$/.test(name)) &&
                !terminalProof(owner, working)
              ? "malformed_status"
              : partial
                ? "abandoned_partial"
                : state.safe
                  ? "stale_job_file"
                  : "recovery_required",
          state.safe &&
            scopedRun(owner, file) &&
            runFiles(file) &&
            !unsafeLocks,
          `Job/status/snapshot/partial recovery set; ${owner?.phase ?? "unknown ownership"}. Never promoted by cleanup.`,
          children(file).reduce(
            (n, child) => n + bytes(path.join(file, child)),
            0,
          ),
          owner?.createdAt ?? stamp(file),
        ),
        relatedPaths: children(file).map((name) => path.join(file, name)),
      });
    } else if (/^evict-[a-f0-9-]{36}$/.test(name) && directory(file)) {
      const owner = readWorkspaceOwner(path.join(file, "owner.json"));
      const state = ownerState(owner, working, deps);
      const known =
        noLinks(file) &&
        children(file).every((n) =>
          ["owner.json", "project.aep", "provenance.json"].includes(n),
        );
      items.push(
        artifact(
          file,
          "temporary",
          "recovery_required",
          state.safe && owner?.phase === "completed" && known && !unsafeLocks,
          "Eviction quarantine; only a confirmed completed eviction is disposable.",
        ),
      );
    } else if (CACHE_NAME.test(name)) {
      const valid = validCache(file);
      let createdAt = stamp(file);
      try {
        const meta = JSON.parse(readFileSync(`${file}.json`, "utf8"));
        const date = meta.lastUsedAt ?? meta.createdAt;
        if (typeof date === "string" && Number.isFinite(Date.parse(date)))
          createdAt = new Date(date).toISOString();
      } catch {
        /* Legacy/invalid provenance. */
      }
      items.push(
        artifact(
          file,
          "cache",
          valid ? null : "cache_entry_invalid",
          false,
          valid
            ? "Validated prepared project + provenance. Retention only, never crash garbage."
            : "Invalid/incomplete cache pair; requires inspection or rebuild on use.",
          bytes(file) + bytes(`${file}.json`),
          createdAt,
        ),
      );
    } else if (
      CACHE_NAME.test(name.replace(/\.json$/, "")) &&
      name.endsWith(".json")
    ) {
      if (!existsSync(file.slice(0, -5)))
        items.push(
          artifact(
            file,
            "unknown",
            "cache_entry_invalid",
            false,
            "Orphaned provenance; manual inspection.",
          ),
        );
    } else if (
      name.endsWith(".aep Logs") &&
      CACHE_NAME.test(name.slice(0, -5))
    ) {
      items.push(
        artifact(
          file,
          "temporary",
          directory(file) && noLinks(file) && validCache(file.slice(0, -5))
            ? null
            : "recovery_required",
          false,
          "Adobe logs; removed with their cache entry only when no workspace is in use.",
        ),
      );
    } else {
      items.push(
        artifact(
          file,
          "unknown",
          "recovery_required",
          false,
          "Unrecognised workspace artifact; never automatically removed.",
        ),
      );
    }
  }
  const cache = items.filter((i) => i.kind === "cache" && i.reason === null);
  const dates = cache
    .map((i) => i.createdAt)
    .filter((date): date is string => date !== null)
    .sort();
  return {
    configured: true,
    problem: null,
    artifacts: items,
    activeJobs: new Set(
      items
        .filter((i) => i.kind === "lock" && i.reason === "lock_owner_alive")
        .map((i) => {
          const owner = readWorkspaceOwner(path.join(i.path, "owner.json"));
          return `${owner?.hostname}:${owner?.pid}:${owner?.trackIdentity}`;
        }),
    ).size,
    orphanedLocks: items.filter(
      (i) => i.kind === "lock" && i.reason === "lock_owner_missing",
    ).length,
    abandonedPartials,
    recoverable: items.filter((i) => i.safe).length,
    manual: items.filter(
      (i) => !i.safe && i.reason !== null && i.reason !== "lock_owner_alive",
    ).length,
    cacheEntries: cache.length,
    cacheBytes: cache.reduce((n, i) => n + i.bytes, 0),
    oldestCache: dates[0] ?? null,
    newestCache: dates.at(-1) ?? null,
    policy: { maxEntries: deps.maxEntries },
  };
};

/** Caller owns the workspace lock; exclude current prepared copy during retention. */
export const prunePreparedCache = (
  config: AfterEffectsConfig,
  keep: string | null,
  lockToken: string,
  maxEntries = CACHE_MAX_ENTRIES,
  allowedPaths?: ReadonlySet<string>,
): { removed: string[]; failures: WorkspaceMaintenance["failures"] } => {
  const { working } = roots(config),
    removed: string[] = [],
    failures: { path: string; reason: "cleanup_failed"; message: string }[] =
      [];
  const owner = readWorkspaceOwner(
    path.join(working, ".toshi-ae-workspace.lock", "owner.json"),
  );
  if (
    owner?.token !== lockToken ||
    owner.pid !== process.pid ||
    owner.hostname !== hostname()
  )
    throw new Error(
      "Prepared cache pruning requires current workspace ownership.",
    );
  if (
    !owner.safeToDelete ||
    !SAFE_PHASES.has(owner.phase) ||
    owner.childPid !== null
  )
    throw new Error(
      "Prepared cache pruning requires confirmed idle ownership, after child shutdown.",
    );
  // The ownership record also protects the resolved copy, even if a caller omits keep.
  keep = owner.preparedProject ?? keep;
  if (keep && existsSync(keep)) keep = realpathSync(keep);
  const entries = inspectAfterEffectsWorkspace(config)
    .artifacts.filter((i) => i.kind === "cache" && i.reason === null)
    .sort(
      (a, b) =>
        (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
        a.path.localeCompare(b.path),
    );
  const retained = new Set(
    entries
      .slice(
        0,
        Math.max(
          0,
          maxEntries -
            (keep && !entries.slice(0, maxEntries).some((i) => i.path === keep)
              ? 1
              : 0),
        ),
      )
      .map((i) => i.path),
  );
  if (keep) retained.add(keep);
  for (const entry of entries.filter(
    (i) => !retained.has(i.path) && (!allowedPaths || allowedPaths.has(i.path)),
  )) {
    if (
      baseProtected(entry.path, config.project) ||
      baseProtected(`${entry.path}.json`, config.project)
    )
      continue;
    const quarantine = path.join(working, `evict-${randomUUID()}`);
    const owner = {
      ...newWorkspaceOwner(),
      phase: "evicting",
      safeToDelete: false,
    };
    let movedProject = false,
      movedProvenance = false;
    try {
      mkdirSync(quarantine, { mode: 0o700 });
      writeWorkspaceOwner(path.join(quarantine, "owner.json"), owner);
      renameSync(entry.path, path.join(quarantine, "project.aep"));
      movedProject = true;
      renameSync(
        `${entry.path}.json`,
        path.join(quarantine, "provenance.json"),
      );
      movedProvenance = true;
      writeWorkspaceOwner(path.join(quarantine, "owner.json"), {
        ...owner,
        phase: "completed",
        safeToDelete: true,
      });
      rmSync(quarantine, { recursive: true });
      removed.push(entry.path, `${entry.path}.json`);
      const logs = `${entry.path} Logs`;
      if (
        directory(logs) &&
        noLinks(logs) &&
        !baseProtected(logs, config.project)
      ) {
        rmSync(logs, { recursive: true });
        removed.push(logs);
      }
    } catch (error) {
      try {
        if (
          movedProvenance &&
          existsSync(path.join(quarantine, "provenance.json"))
        )
          renameSync(
            path.join(quarantine, "provenance.json"),
            `${entry.path}.json`,
          );
        if (movedProject && existsSync(path.join(quarantine, "project.aep")))
          renameSync(path.join(quarantine, "project.aep"), entry.path);
        if (
          directory(quarantine) &&
          children(quarantine).every((n) => n.startsWith("owner.json"))
        )
          rmSync(quarantine, { recursive: true });
      } catch {
        /* Evidence retained on rollback failure; never accepted as cache. */
      }
      failures.push({
        path: entry.path,
        reason: "cleanup_failed",
        message: String(error),
      });
    }
  }
  return { removed, failures };
};

export const maintainAfterEffectsWorkspace = (
  config: AfterEffectsConfig,
  options: {
    dryRun: boolean;
    prune: boolean;
    expectedPaths?: readonly string[];
  },
  overrides: Partial<WorkspaceDeps> = {},
): WorkspaceMaintenance => {
  const deps = { ...defaults, ...overrides },
    inspection = inspectAfterEffectsWorkspace(config, deps),
    { working } = roots(config);
  const candidates = inspection.artifacts.filter(
    (i) => i.safe && !baseProtected(i.path, config.project),
  );
  const blocked = inspection.artifacts.some(
    (i) => i.kind === "lock" && !i.safe,
  );
  if (options.prune && !blocked) {
    const cache = inspection.artifacts
      .filter((i) => i.kind === "cache" && i.reason === null)
      .sort(
        (a, b) =>
          (b.createdAt ?? "").localeCompare(a.createdAt ?? "") ||
          a.path.localeCompare(b.path),
      );
    candidates.push(
      ...cache
        .slice(deps.maxEntries)
        .filter((i) => !baseProtected(i.path, config.project))
        .map((i) => ({
          ...i,
          safe: true,
          reason: "cache_retention" as const,
          details: `Exceeds ${deps.maxEntries} prepared entries; project and provenance removed together.`,
          relatedPaths: [
            `${i.path}.json`,
            ...(directory(`${i.path} Logs`) &&
            noLinks(`${i.path} Logs`) &&
            !baseProtected(`${i.path} Logs`, config.project)
              ? [`${i.path} Logs`]
              : []),
          ],
        })),
    );
  }
  const removed: string[] = [],
    failures: { path: string; reason: "cleanup_failed"; message: string }[] =
      [];
  if (options.dryRun)
    return { dryRun: true, candidates, removed, failures, inspection };
  if (
    options.expectedPaths &&
    JSON.stringify([...options.expectedPaths].sort()) !==
      JSON.stringify(
        candidates.flatMap((i) => [i.path, ...(i.relatedPaths ?? [])]).sort(),
      )
  ) {
    return {
      dryRun: false,
      candidates,
      removed: [],
      failures: [
        {
          path: working,
          reason: "cleanup_failed",
          message:
            "Workspace cleanup plan changed; preview again before applying.",
        },
      ],
      inspection,
    };
  }
  // Safely reclaim only guarded, byte-identical ownership snapshots. Never age alone.
  for (const item of candidates.filter((i) => i.kind === "lock")) {
    try {
      const before = diskIdentity(path.join(item.path, "owner.json"));
      withWorkspaceLockGuard(item.path, () => {
        if (
          diskIdentity(path.join(item.path, "owner.json")) !== before ||
          !ownerState(
            readWorkspaceOwner(path.join(item.path, "owner.json")),
            working,
            deps,
          ).safe ||
          !lockFiles(item.path)
        )
          throw new Error("Lock ownership changed or completion uncertain.");
        rmSync(item.path, { recursive: true });
        removed.push(item.path);
      });
    } catch (error) {
      failures.push({
        path: item.path,
        reason: "cleanup_failed",
        message: String(error),
      });
    }
  }
  // Reinspect after lock recovery, then acquire the same workspace fence used
  // by preparation/rendering; concurrent renders prevent all deletion/pruning.
  if (blocked || failures.length)
    return {
      dryRun: false,
      candidates,
      removed,
      failures,
      inspection: inspectAfterEffectsWorkspace(config, deps),
    };
  if (!directory(working))
    return { dryRun: false, candidates, removed, failures, inspection };
  let release: ReturnType<typeof acquireAfterEffectsStagingLock> | null = null;
  try {
    release = acquireAfterEffectsStagingLock(
      path.join(working, "workspace.json"),
      ".toshi-ae-workspace.lock",
    );
    for (const item of candidates.filter(
      (i) => i.kind === "run" || i.kind === "temporary",
    )) {
      const owner = readWorkspaceOwner(path.join(item.path, "owner.json"));
      if (
        !ownerState(owner, working, deps).safe ||
        (item.kind === "run"
          ? !scopedRun(owner, item.path) || !runFiles(item.path)
          : owner?.phase !== "completed" ||
            !noLinks(item.path) ||
            children(item.path).some(
              (n) =>
                !["owner.json", "project.aep", "provenance.json"].includes(n),
            )) ||
        baseProtected(item.path, config.project)
      )
        throw new Error(`Run changed or ownership uncertain: ${item.path}`);
      rmSync(item.path, { recursive: true });
      removed.push(item.path);
    }
    if (options.prune) {
      const result = prunePreparedCache(
        config,
        null,
        release.token,
        deps.maxEntries,
        new Set(
          candidates.filter((i) => i.kind === "cache").map((i) => i.path),
        ),
      );
      removed.push(...result.removed);
      failures.push(...result.failures);
    }
  } catch (error) {
    failures.push({
      path: working,
      reason: "cleanup_failed",
      message: String(error),
    });
  } finally {
    try {
      release?.();
    } catch (error) {
      failures.push({
        path: working,
        reason: "cleanup_failed",
        message: String(error),
      });
    }
  }
  return {
    dryRun: false,
    candidates,
    removed,
    failures,
    inspection: inspectAfterEffectsWorkspace(config, deps),
  };
};

export const afterEffectsWorkspace: RendererWorkspace = {
  inspect: async () => {
    try {
      return inspectAfterEffectsWorkspace(readAfterEffectsConfig());
    } catch (error) {
      return {
        configured: false,
        problem: String(error),
        artifacts: [],
        activeJobs: 0,
        orphanedLocks: 0,
        abandonedPartials: 0,
        recoverable: 0,
        manual: 0,
        cacheEntries: 0,
        cacheBytes: 0,
        oldestCache: null,
        newestCache: null,
        policy: { maxEntries: CACHE_MAX_ENTRIES },
      };
    }
  },
  maintain: async (options) =>
    maintainAfterEffectsWorkspace(readAfterEffectsConfig(), options),
};
