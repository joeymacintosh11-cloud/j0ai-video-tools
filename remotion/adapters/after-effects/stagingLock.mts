import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";

/** Shared footage is read in place by aerender. Fail closed across processes:
 * an interrupted owner leaves this lock for manual inspection, since a dead
 * worker does not prove its Adobe child has stopped reading staged files. */
export const acquireAfterEffectsStagingLock = (dataFile: string): (() => void) => {
  const folder = path.join(realpathSync(path.dirname(dataFile)), ".toshi-ae-render.lock");
  try { mkdirSync(folder); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new TrackError(trackIssue("RENDER_TARGET_LOCKED",
      `After Effects staging is locked at ${folder}. AE renders run serially. ` +
      "Wait for the current render; after an interrupted render, verify aerender has stopped before removing this lock."));
  }
  const token = randomUUID();
  const owner = path.join(folder, "owner.json");
  try { writeFileSync(owner, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() })); }
  catch (error) { rmSync(folder, { recursive: true, force: true }); throw error; }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    // Never remove a successor's lock or a lock whose ownership is uncertain.
    try {
      if (JSON.parse(readFileSync(owner, "utf8")).token === token) rmSync(folder, { recursive: true });
    } catch { /* Leave uncertain ownership for manual inspection. */ }
  };
};
