import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { hostname as osHostname } from "node:os";
import path from "node:path";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import {
  assertRenderPresetId,
  isRenderPresetId,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import { OUT_DIR } from "../tracks/trackLocations.ts";

/**
 * One owner at a time per slug+presetId, across processes.
 *
 * The render manager's queue dedupes jobs inside one server, but the CLI is a
 * separate process with no view of that queue, so both could previously render
 * and publish the same target at once. This is the cross-process layer: a lock
 * file whose *creation* is the exclusivity primitive, never a read followed by
 * a write.
 *
 * Targets are independent — locking ghetto-geek/square-1x1 says nothing about
 * ghetto-geek/youtube-16x9 — so unrelated work still runs back to back. There
 * is deliberately no global render lock.
 *
 * Lock metadata is for reporting and for recovery decisions only. Exclusivity
 * comes from O_EXCL and nothing else, so a truncated or hand-edited lock file
 * can never let two owners in.
 */

export const RENDER_LOCK_SCHEMA_VERSION = 1;

/** Internal runtime state, not a user-facing artefact. Lives under out/, which is gitignored. */
export const RENDER_LOCK_DIR = path.join(OUT_DIR, ".locks");

export type RenderLockOwner = {
  readonly schemaVersion: number;
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly pid: number;
  readonly hostname: string;
  readonly createdAt: string;
  /** The render job this lock belongs to, when one exists. */
  readonly jobId: string | null;
  /** Identifies this acquisition, so a release cannot remove someone else's lock. */
  readonly token: string;
};

/**
 * What a lock file says, if anything.
 *
 * "malformed" is kept distinct from "held": an unreadable lock is never
 * reclaimed automatically, because we cannot tell whether a live process is
 * behind it.
 */
export type RenderLockState =
  | { readonly state: "free" }
  | { readonly state: "held"; readonly owner: RenderLockOwner }
  | { readonly state: "malformed"; readonly file: string };

export type RenderLockOptions = {
  /** Lock directory. Overridden by tests so they never touch the real out/. */
  readonly root?: string;
  readonly pid?: number;
  readonly hostname?: string;
  readonly jobId?: string | null;
  /** Liveness probe, injected by tests; defaults to signal 0. */
  readonly isAlive?: (pid: number) => boolean;
};

export type RenderTargetLock = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly file: string;
  readonly token: string;
  /** Idempotent, and only ever removes a lock this handle still owns. */
  readonly release: () => void;
};

/**
 * A process we could signal exists. EPERM means it exists but belongs to
 * someone else, which still counts as alive.
 */
const processIsAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * The lock file for one target, guaranteed to sit directly in the lock root.
 *
 * Both components are validated first, so neither can contain a separator or
 * "..". The containment assertion after that is belt and braces: it means no
 * future change to slug or preset rules can turn this into a path escape.
 */
export const renderLockFile = (
  slug: string,
  presetId: RenderPresetId,
  root: string = RENDER_LOCK_DIR,
): string => {
  const validSlug = assertValidSlug(slug);
  const validPreset = assertRenderPresetId(presetId);
  const file = path.resolve(root, `${validSlug}__${validPreset}.lock`);

  if (path.dirname(file) !== path.resolve(root)) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        `Refusing a render lock path outside ${root}.`,
      ),
    );
  }

  return file;
};

const parseOwner = (raw: string): RenderLockOwner | null => {
  try {
    const value = JSON.parse(raw) as RenderLockOwner;
    const valid =
      value?.schemaVersion === RENDER_LOCK_SCHEMA_VERSION &&
      typeof value.slug === "string" &&
      isRenderPresetId(value.presetId) &&
      Number.isInteger(value.pid) &&
      typeof value.hostname === "string" &&
      typeof value.token === "string" &&
      value.token.length > 0 &&
      Number.isFinite(Date.parse(value.createdAt));

    return valid ? value : null;
  } catch {
    return null;
  }
};

const readLockFile = (file: string): RenderLockState => {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { state: "free" };
    }
    // Unreadable for any other reason is treated as occupied, not as free.
    return { state: "malformed", file };
  }

  const owner = parseOwner(raw);

  return owner ? { state: "held", owner } : { state: "malformed", file };
};

/** Non-authoritative: what a lock file says right now. Only creation decides ownership. */
export const inspectRenderTargetLock = (
  slug: string,
  presetId: RenderPresetId,
  options: RenderLockOptions = {},
): RenderLockState =>
  readLockFile(renderLockFile(slug, presetId, options.root ?? RENDER_LOCK_DIR));

/**
 * Whether a lock is provably abandoned.
 *
 * Deliberately one-sided. A dead PID on this machine is the only thing that
 * lets us reclaim, because PID reuse can only make a dead owner look *alive* —
 * which costs a stuck lock, recoverable by hand — and never make a live owner
 * look dead, which would cost two renders publishing the same file. A lock
 * written by another host is never touched, and neither is a malformed one.
 */
const isAbandoned = (
  owner: RenderLockOwner,
  hostname: string,
  isAlive: (pid: number) => boolean,
): boolean => owner.hostname === hostname && !isAlive(owner.pid);

const lockedError = (
  slug: string,
  presetId: RenderPresetId,
  state: RenderLockState,
): TrackError => {
  const detail =
    state.state === "held"
      ? `Held by process ${state.owner.pid} on ${state.owner.hostname}` +
        `${state.owner.jobId ? ` (job ${state.owner.jobId})` : ""}` +
        ` since ${state.owner.createdAt}.`
      : `A lock file exists but could not be read, so it is being left alone.`;

  return new TrackError(
    trackIssue(
      "RENDER_TARGET_LOCKED",
      `${slug} / ${presetId} is already being rendered by another process. ${detail} ` +
        `Wait for it to finish, or clear the lock with \`npm run render-locks -- --release ${slug} ${presetId}\` ` +
        `once you are certain nothing is rendering it.`,
    ),
  );
};

/**
 * Takes the lock for one target, or throws RENDER_TARGET_LOCKED.
 *
 * O_EXCL creation is the whole mechanism: whoever creates the file owns the
 * target. A provably abandoned lock is reclaimed by renaming it aside first —
 * also atomic, so of several processes racing to reclaim, exactly one wins the
 * rename and the losers simply retry the creation.
 */
export const acquireRenderTargetLock = (
  slug: string,
  presetId: RenderPresetId,
  options: RenderLockOptions = {},
): RenderTargetLock => {
  const root = options.root ?? RENDER_LOCK_DIR;
  const hostname = options.hostname ?? osHostname();
  const isAlive = options.isAlive ?? processIsAlive;
  const file = renderLockFile(slug, presetId, root);

  mkdirSync(root, { recursive: true });

  // Bounded: each pass either acquires, reclaims one abandoned lock, or gives
  // up. It cannot spin against a live owner.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const token = randomUUID();
    const owner: RenderLockOwner = {
      schemaVersion: RENDER_LOCK_SCHEMA_VERSION,
      slug: assertValidSlug(slug),
      presetId: assertRenderPresetId(presetId),
      pid: options.pid ?? process.pid,
      hostname,
      createdAt: new Date().toISOString(),
      jobId: options.jobId ?? null,
      token,
    };

    let descriptor: number;
    try {
      descriptor = openSync(file, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;

      const state = readLockFile(file);

      if (state.state === "free") continue;
      if (
        state.state === "malformed" ||
        !isAbandoned(state.owner, hostname, isAlive)
      ) {
        throw lockedError(slug, presetId, state);
      }

      // Provably abandoned: move it aside, then let the next pass create ours.
      // Losing this race is fine — the winner's lock is what the retry sees.
      try {
        const aside = `${file}.abandoned-${token}`;
        renameSync(file, aside);
        unlinkSync(aside);
      } catch {
        // Someone else reclaimed it first, or it vanished. Retry.
      }
      continue;
    }

    try {
      writeSync(descriptor, `${JSON.stringify(owner, null, 2)}\n`);
    } finally {
      closeSync(descriptor);
    }

    let released = false;

    return {
      slug: owner.slug,
      presetId: owner.presetId,
      file,
      token,
      release: () => {
        if (released) return;
        released = true;
        releaseLockFile(file, token);
      },
    };
  }

  throw lockedError(slug, presetId, readLockFile(file));
};

/**
 * Removes a lock only if it is still the one identified by `token`.
 *
 * Without the token check, an owner that had already been reclaimed as
 * abandoned could come back and delete its successor's lock.
 */
const releaseLockFile = (file: string, token: string): void => {
  const state = readLockFile(file);

  if (state.state === "held" && state.owner.token !== token) return;
  if (state.state === "malformed") return;

  try {
    unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
};

/** Holds the lock for exactly the duration of `work`, releasing on every path. */
export const withRenderTargetLock = async <T>(
  slug: string,
  presetId: RenderPresetId,
  work: () => Promise<T>,
  options: RenderLockOptions = {},
): Promise<T> => {
  const lock = acquireRenderTargetLock(slug, presetId, options);

  try {
    return await work();
  } finally {
    lock.release();
  }
};

export type RenderLockEntry = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly file: string;
  readonly owner: RenderLockOwner | null;
  /** True when the owning process is gone, so the next render will reclaim it. */
  readonly abandoned: boolean;
};

/** Every lock currently on disk, for the recovery CLI and for diagnostics. */
export const listRenderLocks = (
  options: RenderLockOptions = {},
): readonly RenderLockEntry[] => {
  const root = options.root ?? RENDER_LOCK_DIR;
  const hostname = options.hostname ?? osHostname();
  const isAlive = options.isAlive ?? processIsAlive;

  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }

  return names
    .filter((name) => name.endsWith(".lock"))
    .sort()
    .map((name) => {
      const file = path.join(root, name);
      const state = readLockFile(file);
      const owner = state.state === "held" ? state.owner : null;
      const [slug, preset] = name.slice(0, -".lock".length).split("__");

      return {
        slug: owner?.slug ?? slug ?? name,
        presetId: (owner?.presetId ?? preset) as RenderPresetId,
        file,
        owner,
        abandoned: owner ? isAbandoned(owner, hostname, isAlive) : false,
      };
    });
};

/**
 * The explicit recovery path, for a lock this process cannot prove is dead —
 * one written by another host, or one whose metadata is unreadable.
 *
 * Takes a slug and a preset, never a path, so it can only ever remove a file
 * this module would itself have created. Returns false when there was nothing
 * to remove.
 */
export const releaseRenderTargetLock = (
  slug: string,
  presetId: RenderPresetId,
  options: RenderLockOptions = {},
): boolean => {
  const file = renderLockFile(slug, presetId, options.root ?? RENDER_LOCK_DIR);

  try {
    unlinkSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};
