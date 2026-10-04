import { spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import type { CancelSignal } from "../../core/ports/renderEngine.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import type { TemplateText } from "./templateContract.mts";

export const PREPARATION_VERSION = "toshi-ae-prep-1";

export type PreparationJob = {
  readonly token: string;
  readonly baseProject: string;
  readonly configuredBaseProject: string;
  readonly preparedProject: string;
  readonly statusFile: string;
  readonly cancelFile: string;
  readonly composition: string;
  readonly marker: string;
  readonly identity: string;
  readonly prepVersion: string;
  readonly text: TemplateText;
  readonly assets: Readonly<Record<string, string>>;
};

export type PreparationStatus = {
  readonly token: string;
  readonly success: boolean;
  readonly preparedProject: string;
  readonly marker: string;
  readonly identity: string;
  readonly composition: string;
  readonly prepVersion: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
};

/** An AppleEvent sender dying does not prove its JSX stopped inside the GUI. */
export class PreparationError extends TrackError {
  readonly uncertain: boolean;
  constructor(message: string, uncertain = false) {
    super(trackIssue("RENDER_FAILED", `Template preparation failed: ${message}`));
    this.uncertain = uncertain;
  }
}

export const validatePreparationStatus = (raw: unknown, job: PreparationJob): PreparationStatus => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PreparationError("Malformed status JSON.", true);
  const value = raw as Record<string, unknown>;
  for (const field of ["token", "preparedProject", "marker", "identity", "composition", "prepVersion"] as const) {
    if (value[field] !== job[field]) throw new PreparationError(`Status ${field} does not match this run; stale status rejected.`, true);
  }
  if (typeof value.success !== "boolean" || (!value.success &&
      (typeof value.errorCode !== "string" || typeof value.errorMessage !== "string"))) {
    throw new PreparationError("Malformed preparation result.", true);
  }
  return value as PreparationStatus;
};

/** AppleScript string literals, not shell quoting. No shell is ever launched. */
export const appleScriptLiteral = (value: string): string =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const runAfterEffectsPreparation = async (input: {
  readonly job: PreparationJob;
  readonly scriptFile: string;
  readonly applicationBundleId: string;
  readonly timeoutMs: number;
  readonly cancelSignal?: CancelSignal;
  readonly spawn?: typeof nodeSpawn;
}): Promise<PreparationStatus> => {
  let cancelled = false;
  let running: ReturnType<typeof nodeSpawn> | null = null;
  input.cancelSignal?.(() => {
    cancelled = true;
    if (running) {
      // Cooperative checkpoints in JSX. Keep this request if completion is uncertain.
      void writeFile(input.job.cancelFile, "cancel").catch(() => {});
      running.kill("SIGTERM");
    }
  });
  if (cancelled) throw new PreparationError("Preparation cancelled before launch.");
  const command = `with timeout of ${Math.ceil(input.timeoutMs / 1000) + 10} seconds\n` +
    `tell application id ${appleScriptLiteral(input.applicationBundleId)} to DoScriptFile ` +
    `(POSIX file ${appleScriptLiteral(input.scriptFile)})\nend timeout`;
  let timedOut = false;
  let stderr = "";
  let launchError: Error | null = null;
  let exitCode: number | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = Date.now() + input.timeoutMs;
  try {
    try {
      running = (input.spawn ?? nodeSpawn)("/usr/bin/osascript", ["-e", command], { stdio: ["ignore", "ignore", "pipe"] });
    } catch (error) {
      throw new PreparationError(`Could not launch osascript: ${String(error)}`);
    }
    const child = running;
    child.stderr?.on("data", (bytes) => { stderr = (stderr + String(bytes)).slice(-4000); });
    const stop = () => {
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    // Cancellation can precede the timeout; bound the sender's lifetime in both cases.
    input.cancelSignal?.(stop);
    timer = setTimeout(() => {
      timedOut = true;
      void writeFile(input.job.cancelFile, "timeout").catch(() => {});
      stop();
    }, input.timeoutMs);
    await new Promise<void>((done) => {
      child.once("error", (error) => { launchError = error; });
      child.once("close", (code) => { exitCode = code; done(); });
    });
    running = null;
    // Never release locks based on exit/stdout alone. Only a matching terminal
    // status proves the JSX has closed its project and finished all mutation.
    if (launchError) throw new PreparationError(`Could not launch osascript: ${String(launchError)}`);
    let status: PreparationStatus;
    try {
      // Some hosts acknowledge an AppleEvent before the script's status is
      // visible. Wait for its atomic publication, bounded by the same deadline.
      // Cancellation gets a short completion grace, never an indefinite wait.
      let completionGrace: number | null = null;
      while (true) {
        if ((cancelled || timedOut) && completionGrace === null) completionGrace = Date.now() + 250;
        try {
          status = validatePreparationStatus(JSON.parse(await readFile(input.job.statusFile, "utf8")), input.job);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          if (Date.now() >= (completionGrace ?? deadline)) throw error;
          await new Promise((done) => setTimeout(done, 25));
        }
      }
    } catch (error) {
      if (error instanceof PreparationError) throw error;
      throw new PreparationError(
        `Missing or malformed status${timedOut ? " (timed out)" : cancelled ? " (cancelled)" : ""}; ` +
        `JSX completion is unconfirmed. ${stderr.trim()} ` +
        (stderr.includes("-1743") ? "macOS denied Automation; enable the calling host's After Effects access in System Settings > Privacy & Security > Automation." :
          /-600|-10810/.test(stderr) ? "After Effects is unavailable; check applicationBundleId and the installation." :
          "Check After Effects > Settings > Scripting & Expressions > Allow Scripts to Write Files and Access Network."), true,
      );
    }
    if (timedOut || cancelled) throw new PreparationError(timedOut ? "Preparation timed out." : "Preparation cancelled.");
    if (exitCode !== 0) throw new PreparationError(`osascript exited ${exitCode}: ${stderr.trim()}`);
    if (!status.success) throw new PreparationError(`${status.errorCode}: ${status.errorMessage}`);
    return status;
  } finally {
    if (timer) clearTimeout(timer);
    if (killTimer) clearTimeout(killTimer);
  }
};
