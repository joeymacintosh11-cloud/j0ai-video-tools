import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fstatSync, linkSync, lstatSync, mkdirSync, openSync,
  readdirSync, readFileSync, unlinkSync, writeSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import path from "node:path";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug, isValidSlug } from "../../core/domain/tracks/slug.ts";
import { assertRenderPresetId, isRenderPresetId, type RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import { OUT_DIR } from "../tracks/trackLocations.ts";

export const RENDER_LOCK_SCHEMA_VERSION = 1;
export const RENDER_LOCK_DIR = path.join(OUT_DIR, ".locks");
export type RenderLockOwner = {
  readonly schemaVersion: number;
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
  readonly jobId: string | null;
  readonly token: string;
};
export type RenderLockState =
  | { readonly state: "free" }
  | { readonly state: "held"; readonly owner: RenderLockOwner }
  | { readonly state: "malformed"; readonly file: string };
export type RenderLockOptions = {
  readonly root?: string;
  readonly pid?: number;
  readonly hostname?: string;
  readonly jobId?: string | null;
  readonly isAlive?: (pid: number) => boolean;
};
export type RenderTargetLock = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly file: string;
  readonly token: string;
  readonly assertOwned: () => void;
  /** Excludes acquisition/recovery/release for the entire synchronous commit. */
  readonly commit: <T>(work: () => T) => T;
  /** For delivery's short IPC/receipt commit; never used for encoding/copying. */
  readonly commitAsync: <T>(work: () => Promise<T>) => Promise<T>;
  readonly release: () => void;
};

const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
const processIsAlive = (pid: number): boolean => {
  try { process.kill(pid, 0); return true; }
  catch (error) { return code(error) !== "ESRCH"; }
};
export const renderLockFile = (slug: string, presetId: RenderPresetId, root = RENDER_LOCK_DIR): string => {
  const file = path.resolve(root, `${assertValidSlug(slug)}__${assertRenderPresetId(presetId)}.lock`);
  // Both components are validated above, so this cannot fire today. It is kept
  // so that a future change to slug or preset rules cannot turn a lock path
  // into an escape without a test noticing.
  if (path.dirname(file) !== path.resolve(root)) {
    throw new TrackError(trackIssue("INVALID_REQUEST", `Refusing a render lock path outside ${root}.`));
  }
  return file;
};

const parseOwner = (raw: string, file: string): RenderLockOwner | null => {
  try {
    const value = JSON.parse(raw) as RenderLockOwner;
    return value?.schemaVersion === RENDER_LOCK_SCHEMA_VERSION &&
      isValidSlug(value.slug) && isRenderPresetId(value.presetId) &&
      path.basename(file) === `${value.slug}__${value.presetId}.lock` &&
      Number.isInteger(value.pid) && value.pid > 0 && value.pid <= 2147483647 &&
      typeof value.hostname === "string" && value.hostname.length > 0 &&
      typeof value.token === "string" && value.token.length > 0 &&
      (value.jobId === null || typeof value.jobId === "string") &&
      typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt))
      ? value : null;
  } catch { return null; }
};
const readLockFile = (file: string): RenderLockState => {
  let fd: number | undefined;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) return { state: "malformed", file };
    const owner = parseOwner(readFileSync(fd, "utf8"), file);
    return owner ? { state: "held", owner } : { state: "malformed", file };
  } catch (error) {
    return code(error) === "ENOENT" ? { state: "free" } : { state: "malformed", file };
  } finally { if (fd !== undefined) closeSync(fd); }
};
export const inspectRenderTargetLock = (slug: string, presetId: RenderPresetId, options: RenderLockOptions = {}): RenderLockState =>
  readLockFile(renderLockFile(slug, presetId, options.root));
const isAbandoned = (owner: RenderLockOwner, options: RenderLockOptions): boolean =>
  owner.hostname === (options.hostname ?? osHostname()) && !(options.isAlive ?? processIsAlive)(owner.pid);
const lockedError = (file: string, message: string): TrackError => new TrackError(trackIssue(
  "RENDER_TARGET_LOCKED", `${path.basename(file).replace("__", " / ").replace(/\.lock$/, "")}: ${message} Inspect with npm run render-locks.`,
));
const identity = (file: string) => {
  const stat = lstatSync(file);
  return `${stat.dev}:${stat.ino}`;
};
/** Reused by every guard retry; Atomics.wait needs shared memory to park on. */
const parkingSlot = new Int32Array(new SharedArrayBuffer(4));
const writeAll = (fd: number, text: string) => {
  const bytes = Buffer.from(text);
  let offset = 0;
  while (offset < bytes.length) {
    const written = writeSync(fd, bytes, offset, bytes.length - offset);
    if (written === 0) throw new Error("Could not finish writing lock metadata.");
    offset += written;
  }
};

/**
 * Every mutation of a target lock — acquisition, recovery, release and
 * publication — happens while holding this guard.
 *
 * It exists because reading a lock and then acting on the path is not atomic:
 * without it, a process that read an abandoned lock could delete or replace the
 * lock a successor had created in the meantime. The guard makes that whole
 * read-decide-act section exclusive, so ownership only ever changes hands under
 * it.
 *
 * Automatic acquisition never clears a guard — guessing wrong about the one
 * section where ownership changes hands is exactly what would admit two owners.
 * A guard left behind by a killed process is cleared only by the manual
 * recovery path, and only when nothing live can still be holding it.
 */
const guardOwner = (guard: string): { pid: number; hostname: string } | null => {
  try {
    const value = JSON.parse(readFileSync(guard, "utf8")) as { pid?: unknown; hostname?: unknown };
    return Number.isInteger(value.pid) && (value.pid as number) > 0 && typeof value.hostname === "string"
      ? { pid: value.pid as number, hostname: value.hostname }
      : null;
  } catch { return null; }
};
/** A guard whose holder is a running process on this host. */
const guardIsLive = (guard: string): boolean => {
  const owner = guardOwner(guard);
  return owner !== null && owner.hostname === osHostname() && processIsAlive(owner.pid);
};

const takeGuard = (file: string): (() => void) => {
  const guard = `${file}.guard`;
  // Metadata is written to a private file first and then linked into place.
  // link() is atomic and fails with EEXIST, so a guard is never visible without
  // complete metadata — which is what makes "unreadable guard" a reliable sign
  // of corruption rather than a live holder caught mid-write.
  const staging = `${guard}.staging-${randomUUID()}`;
  let expected: string;
  const fd = openSync(staging, "wx", 0o600);
  try {
    expected = `${fstatSync(fd).dev}:${fstatSync(fd).ino}`;
    writeAll(fd, JSON.stringify({ pid: process.pid, hostname: osHostname(), token: randomUUID() }));
  } catch (error) {
    closeSync(fd);
    unlinkSync(staging);
    throw error;
  }
  closeSync(fd);

  let held = false;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try { linkSync(staging, guard); held = true; break; }
      catch (error) {
        if (code(error) !== "EEXIST") throw error;
        // Briefly retry another live process's synchronous operation. Never
        // block this event loop waiting for this process's own asynchronous
        // delivery commit, and never wait on an abandoned guard.
        const owner = guardOwner(guard);
        if (owner === null || owner.pid === process.pid || owner.hostname !== osHostname() || !processIsAlive(owner.pid)) break;
        Atomics.wait(parkingSlot, 0, 0, 1);
      }
    }
  } finally {
    unlinkSync(staging);
  }

  if (!held) {
    throw lockedError(file, guardIsLive(guard)
      ? "Another ownership operation on this target is in progress."
      : "An ownership guard was left behind; clear it with npm run render-locks -- --release.");
  }
  return () => {
    // Only this guard holder may remove it. No supported operation displaces it.
    if (identity(guard) !== expected) throw lockedError(file, "Ownership guard was replaced; refusing cleanup.");
    unlinkSync(guard);
  };
};

/**
 * Clears a guard nothing can still be using.
 *
 * Only the manual recovery path calls this: the operator has asserted that
 * nothing is rendering the target. Automatic acquisition never clears a guard,
 * because a guard is held across the short section where ownership itself
 * changes hands and guessing wrong there would admit two owners.
 *
 * A guard held by a running process on this host is never touched. Everything
 * else — a dead holder, another host, or metadata that cannot be parsed at all
 * (impossible for a live holder, since metadata is linked into place complete) —
 * may be cleared.
 */
const clearAbandonedGuard = (file: string): boolean => {
  const guard = `${file}.guard`;
  let before: string;
  try { before = identity(guard); } catch { return false; }
  if (guardIsLive(guard)) return false;
  try {
    if (identity(guard) !== before) return false;
    unlinkSync(guard);
    return true;
  } catch { return false; }
};

/**
 * Runs `work` with the guard held.
 *
 * A guard-release failure is only surfaced when the work itself succeeded:
 * otherwise it would mask the error the caller actually needs to see.
 */
const guarded = <T>(file: string, work: () => T): T => {
  const release = takeGuard(file);
  let result: T;
  try {
    result = work();
  } catch (error) {
    // Keep the error the caller needs to see; a guard problem on an already
    // failing path would only mask it.
    try { release(); } catch { /* reported on the success path only */ }
    throw error;
  }
  release();
  return result;
};
const sameOwner = (file: string, token: string, expectedIdentity: string): boolean => {
  const state = readLockFile(file);
  if (state.state !== "held" || state.owner.token !== token) return false;
  try { return identity(file) === expectedIdentity; } catch { return false; }
};

export const acquireRenderTargetLock = (slug: string, presetId: RenderPresetId, options: RenderLockOptions = {}): RenderTargetLock => {
  const file = renderLockFile(slug, presetId, options.root);
  mkdirSync(path.dirname(file), { recursive: true });
  if (!lstatSync(path.dirname(file)).isDirectory()) throw lockedError(file, "Lock root must be a real directory.");
  return guarded(file, () => {
    const state = readLockFile(file);
    if (state.state !== "free") {
      if (state.state !== "held" || !isAbandoned(state.owner, options)) {
        throw lockedError(file, state.state === "held"
          ? `Held by process ${state.owner.pid} on ${state.owner.hostname}${state.owner.jobId ? ` (job ${state.owner.jobId})` : ""} since ${state.owner.createdAt}.`
          : "Unreadable lock metadata; refusing automatic recovery.");
      }
      const expected = identity(file);
      // Re-read immediately before destruction, while all competing operations
      // are excluded. No rename-aside path can accidentally move a successor.
      if (!sameOwner(file, state.owner.token, expected)) throw lockedError(file, "Owner changed during recovery.");
      unlinkSync(file);
    }
    const owner: RenderLockOwner = {
      schemaVersion: RENDER_LOCK_SCHEMA_VERSION, slug, presetId,
      pid: options.pid ?? process.pid, hostname: options.hostname ?? osHostname(),
      createdAt: new Date().toISOString(), jobId: options.jobId ?? null, token: randomUUID(),
    };
    if (!parseOwner(JSON.stringify(owner), file)) throw lockedError(file, "Invalid owner metadata.");
    const fd = openSync(file, "wx", 0o600);
    const stat = fstatSync(fd);
    const expected = `${stat.dev}:${stat.ino}`;
    try { writeAll(fd, `${JSON.stringify(owner, null, 2)}\n`); }
    catch (error) {
      // Still inside the guard; remove only the inode we exclusively created.
      if (identity(file) === expected) unlinkSync(file);
      throw error;
    } finally { closeSync(fd); }
    let released = false;
    const assertOwned = () => {
      if (released || !sameOwner(file, owner.token, expected)) throw lockedError(file, "Render ownership lost; refusing publication.");
    };
    return {
      slug, presetId, file, token: owner.token, assertOwned,
      commit: <T>(work: () => T): T => guarded(file, () => { assertOwned(); return work(); }),
      commitAsync: async <T>(work: () => Promise<T>): Promise<T> => {
        const release = takeGuard(file);
        try { assertOwned(); return await work(); } finally { release(); }
      },
      release: () => {
        if (released) return;
        // Never throws. This runs in a finally around real work, so a lock that
        // cannot be removed must not turn a finished render into a failed one.
        // A lock left behind is recoverable — it becomes reclaimable once this
        // process exits, and `npm run render-locks` shows it meanwhile.
        try {
          guarded(file, () => {
            if (sameOwner(file, owner.token, expected)) unlinkSync(file);
          });
        } catch {
          // Deliberately swallowed; see above.
        }
        released = true;
      },
    };
  });
};
export const withRenderTargetLock = async <T>(slug: string, presetId: RenderPresetId, work: (lock: RenderTargetLock) => Promise<T>, options: RenderLockOptions = {}): Promise<T> => {
  const lock = acquireRenderTargetLock(slug, presetId, options);
  try { return await work(lock); } finally { lock.release(); }
};
export type RenderLockEntry = {
  readonly slug: string; readonly presetId: RenderPresetId; readonly file: string;
  readonly owner: RenderLockOwner | null; readonly abandoned: boolean;
};
export const listRenderLocks = (options: RenderLockOptions = {}): readonly RenderLockEntry[] => {
  const root = options.root ?? RENDER_LOCK_DIR;
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  return names.filter((name) => name.endsWith(".lock")).sort().map((name) => {
    const file = path.join(root, name);
    const state = readLockFile(file);
    const owner = state.state === "held" ? state.owner : null;
    const [slug, presetId] = name.slice(0, -5).split("__");
    return { file, slug, presetId: presetId as RenderPresetId, owner, abandoned: owner ? isAbandoned(owner, options) : false };
  });
};
/** A manual release cannot revoke a live, foreign, or unidentifiable owner. */
export const releaseRenderTargetLock = (slug: string, presetId: RenderPresetId, options: RenderLockOptions = {}): boolean => {
  const file = renderLockFile(slug, presetId, options.root);
  mkdirSync(path.dirname(file), { recursive: true });
  const attempt = () => guarded(file, () => {
    const state = readLockFile(file);
    if (state.state === "free") return false;
    if (state.state !== "held" || !isAbandoned(state.owner, options)) throw lockedError(file, "Cannot prove the owner is dead on this host; refusing release.");
    const expected = identity(file);
    if (!sameOwner(file, state.owner.token, expected)) throw lockedError(file, "Owner changed before release.");
    unlinkSync(file);
    return true;
  });

  try {
    return attempt();
  } catch (error) {
    // A guard left behind by a killed process would otherwise make the target
    // permanently unusable, including by this recovery path. Clearing it is
    // allowed here and nowhere else, and still never touches a live holder.
    if (!(error instanceof TrackError) || !clearAbandonedGuard(file)) throw error;
    return attempt();
  }
};
