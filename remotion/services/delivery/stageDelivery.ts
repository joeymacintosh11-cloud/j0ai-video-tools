import { fork } from "node:child_process";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { directoryIdentity } from "./deliveryDestination.ts";

/**
 * Runs one delivery copy in a helper whose working directory is pinned to the
 * validated destination folder.
 *
 * Node cannot do directory-relative filesystem calls (there is no openat), and
 * changing the server's own working directory is not an option, so a
 * short-lived child is the only way to get that guarantee. Everything it writes
 * resolves through a kernel-held reference to the directory that was validated,
 * which a later rename or symlink of the pathname cannot redirect.
 *
 * Every wait here is bounded. Delivery holds the render target lock for its
 * whole duration, so an unbounded wait would make that target unusable until
 * the process was restarted — a wedged helper has to fail, not block.
 */

type CopyEvent = {
  readonly type: string;
  readonly message?: string;
  readonly bytes: number;
  readonly mtimeMs: number;
};

/** Generous: this covers copying the whole video, on a possibly synced disk. */
const STAGE_TIMEOUT_MS = 10 * 60 * 1000;
/** Short: a rename and a stat inside a directory already held open. */
const COMMIT_TIMEOUT_MS = 60 * 1000;
const EXIT_GRACE_MS = 2000;

/**
 * True if `promise` settled within `ms`.
 *
 * The timer is referenced, not unref'd: this is a wait the caller depends on,
 * so the event loop must stay alive for it. An unreferenced timer can neither
 * fire nor hold the loop open, which makes the whole wait silently vanish when
 * nothing else is pending. It is always cleared, so it never outlives the race.
 */
const settledWithin = async (
  promise: Promise<unknown>,
  ms: number,
): Promise<boolean> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise.then(() => true),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const failed = (message: string): TrackError =>
  new TrackError(trackIssue("UPLOAD_FAILED", message));

export const stageDelivery = async (
  root: string,
  relative: string,
  source: string,
) => {
  const [folder, filename] = relative.split("/");
  const child = fork(
    new URL("./delivery-copy-worker.mts", import.meta.url),
    [
      JSON.stringify({
        root,
        rootIdentity: directoryIdentity(root),
        folder,
        filename,
        source,
      }),
    ],
    { cwd: root, stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );

  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-2000);
  });

  const events: CopyEvent[] = [];
  let waiter:
    | { resolve: (event: CopyEvent) => void; reject: (error: Error) => void }
    | undefined;
  let ended = false;
  let failure: Error | undefined;

  // Deliberately "exit", not "close": close also waits for stdio to drain, and
  // once both ends have disconnected the IPC channel it may never arrive. The
  // helper having exited is what this actually needs to know.
  const finished = new Promise<void>((resolve) =>
    child.once("exit", () => {
      ended = true;
      waiter?.reject(
        failure ??
          failed(`The delivery helper exited before finishing. ${stderr}`.trim()),
      );
      waiter = undefined;
      resolve();
    }),
  );
  child.on("error", (error) => {
    failure = error;
    waiter?.reject(error);
    waiter = undefined;
  });
  child.on("message", (event: CopyEvent) => {
    if (waiter) {
      const current = waiter;
      waiter = undefined;
      current.resolve(event);
    } else events.push(event);
  });

  /**
   * Stops the helper, preferring its own cleanup.
   *
   * Losing the IPC channel is what the helper treats as an abort, so it removes
   * its own staged file and exits. Killing is the last resort: a helper wedged
   * in a filesystem call cannot clean up, and its temp file surviving is better
   * than this process deleting a path it can no longer identify.
   *
   * Bounded throughout, including the final wait, so stopping can never become
   * the thing that blocks the caller.
   */
  const stop = async (): Promise<void> => {
    if (child.connected && child.exitCode === null) child.disconnect();
    if (
      !(await settledWithin(finished, EXIT_GRACE_MS)) &&
      child.exitCode === null
    ) {
      child.kill("SIGKILL");
      await settledWithin(finished, EXIT_GRACE_MS);
    }
  };

  const expect = async (type: string, timeoutMs: number): Promise<CopyEvent> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const event =
        events.shift() ??
        (await new Promise<CopyEvent>((resolve, reject) => {
          if (failure || ended) {
            reject(failure ?? failed("The delivery helper exited."));
            return;
          }
          waiter = { resolve, reject };
          timer = setTimeout(() => {
            waiter = undefined;
            reject(
              failed(
                `The delivery helper stopped responding after ${Math.round(timeoutMs / 1000)}s.`,
              ),
            );
          }, timeoutMs);
        }));

      if (event.type === "error") throw failed(event.message ?? "Delivery failed.");
      if (event.type !== type) throw failed("Unexpected delivery helper response.");
      return event;
    } catch (error) {
      await stop();
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const send = (command: string): Promise<void> =>
    new Promise((resolve, reject) => {
      if (!child.connected) {
        reject(failed("The delivery helper disconnected."));
        return;
      }
      child.send(command, (error) => (error ? reject(error) : resolve()));
    });

  await expect("staged", STAGE_TIMEOUT_MS);

  return {
    commit: async () => {
      await send("commit");
      const event = await expect("delivered", COMMIT_TIMEOUT_MS);
      return { size: event.bytes, mtimeMs: event.mtimeMs };
    },
    close: stop,
  };
};
