import { constants, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync } from "node:fs";
import { copyFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { directoryIdentity } from "./deliveryDestination.ts";

// cwd is pinned by the OS, unlike an absolute pathname whose directory entries
// can be replaced. This helper keeps fs.copyFile (no JS video buffers), adds no
// dependency, and never changes the server process's working directory.
const { root, rootIdentity, folder, filename, source } = JSON.parse(process.argv[2]) as {
  root: string; rootIdentity: string; folder: string; filename: string; source: string;
};
let disconnected = false;
let decide: ((commit: boolean) => void) | undefined;
const decision = new Promise<boolean>((resolve) => { decide = resolve; });
process.on("message", (command) => decide?.(command === "commit"));
process.on("disconnect", () => { disconnected = true; decide?.(false); });
const send = (message: unknown): Promise<void> => new Promise((resolve, reject) => {
  if (!process.connected || !process.send) { reject(new Error("Delivery parent disconnected.")); return; }
  process.send(message, (error) => error ? reject(error) : resolve());
});
const staged = `.deliver-${randomUUID()}.mp4.tmp`;
let inDestination = false;
let created = false;
try {
  if (path.basename(folder) !== folder || folder === "." || folder === ".." || path.basename(filename) !== filename)
    throw new Error("Invalid delivery path segment.");
  if (directoryIdentity(".") !== rootIdentity || realpathSync(root) !== root || directoryIdentity(root) !== rootIdentity)
    throw new Error("Delivery root changed before copying.");
  try { mkdirSync(folder); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (!lstatSync(folder).isDirectory()) throw new Error("Delivery folder must not be a symlink.");
  const expectedDirectory = directoryIdentity(folder);
  process.chdir(folder);
  inDestination = true;
  const assertStable = () => {
    const named = path.join(root, folder);
    if (disconnected || directoryIdentity(".") !== expectedDirectory || directoryIdentity("..") !== rootIdentity ||
        realpathSync(root) !== root || directoryIdentity(root) !== rootIdentity ||
        !lstatSync(named).isDirectory() || directoryIdentity(named) !== expectedDirectory)
      throw new Error("Delivery directory changed; refusing publication.");
  };
  assertStable();
  // Exclusive copy prevents a pre-existing temporary symlink from being followed.
  // copyFile removes a partial destination on failure; created controls our cleanup.
  created = true;
  try {
    await copyFile(source, staged, constants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") created = false;
    throw error;
  }
  assertStable();
  const stats = lstatSync(staged);
  if (!stats.isFile() || stats.size === 0) throw new Error("Delivery staging file is empty or invalid.");
  await send({ type: "staged" });
  if (!await decision) throw new Error("Delivery aborted before publication.");
  assertStable();
  renameSync(staged, filename);
  const delivered = statSync(filename);
  if (delivered.ino !== stats.ino || delivered.size !== stats.size || delivered.mtimeMs !== stats.mtimeMs)
    throw new Error("Delivered file changed during publication.");
  await send({ type: "delivered", bytes: stats.size, mtimeMs: stats.mtimeMs });
} catch (error) {
  if (process.connected) await send({ type: "error", message: error instanceof Error ? error.message : String(error) }).catch(() => {});
} finally {
  if (inDestination && created) rmSync(staged, { force: true });
  if (process.connected) process.disconnect();
}
