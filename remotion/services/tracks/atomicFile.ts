import { randomUUID } from "node:crypto";
import { open, rename, rm, type FileHandle } from "node:fs/promises";

/** Serialize read/modify/write operations within this process. Never retain idle keys. */
const pending = new Map<string, Promise<void>>();
export const withFileMutation = async <T>(
  destination: string,
  operation: () => Promise<T>,
): Promise<T> => {
  const previous = pending.get(destination) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  pending.set(destination, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (pending.get(destination) === current) pending.delete(destination);
  }
};

/**
 * Stage in the destination directory, exclusively, then publish a complete file.
 * The callback may close its handle (stream.pipeline does); close() is idempotent.
 * Never clean up a path we failed to create.
 */
export const writeAtomicFile = async (
  destination: string,
  write: (handle: FileHandle) => Promise<void>,
  beforeCommit?: () => Promise<void>,
): Promise<void> => {
  const temporary = `${destination}.tmp-${randomUUID()}`;
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporary, "wx");
    await write(handle);
    await handle.close();
    await beforeCommit?.();
    await rename(temporary, destination);
  } finally {
    if (handle) {
      try {
        await handle.close();
      } finally {
        // Also handles rename/write failures, after the stream/fd has closed.
        await rm(temporary, { force: true });
      }
    }
  }
};
