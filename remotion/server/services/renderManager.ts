import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import {
  isTerminalStatus,
  type RenderJobError,
  type RenderJobLogEntry,
  type RenderJobStatus,
  type RenderJobView,
  type WorkerEvent,
} from "../types.ts";

const WORKER_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "render-worker.mts",
);

const MAX_LOG_ENTRIES = 200;
/** How long a graceful cancel gets before the process is killed outright. */
const CANCEL_GRACE_MS = 20000;

export type RenderJobEvent =
  | { readonly type: "status"; readonly job: RenderJobView }
  | { readonly type: "progress"; readonly job: RenderJobView }
  | { readonly type: "log"; readonly entry: RenderJobLogEntry }
  | { readonly type: "completed"; readonly job: RenderJobView }
  | { readonly type: "failed"; readonly job: RenderJobView }
  | { readonly type: "cancelled"; readonly job: RenderJobView };

type JobListener = (event: RenderJobEvent) => void;

type RenderJob = {
  id: string;
  slug: string;
  status: RenderJobStatus;
  progress: number;
  framesRendered: number | null;
  totalFrames: number | null;
  fps: number | null;
  queuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  outputPath: string | null;
  outputLabel: string | null;
  error: RenderJobError | null;
  logs: RenderJobLogEntry[];
  listeners: Set<JobListener>;
  child: ChildProcess | null;
  cancelRequested: boolean;
  killTimer: NodeJS.Timeout | null;
};

/**
 * Owns render job lifecycle, separately from any HTTP request.
 *
 * One render runs at a time. That's deliberate: a render already uses three
 * Chromium tabs, and running two at once on 16 GB would thrash rather than
 * finish sooner. Additional requests queue.
 */
class RenderManager {
  private readonly jobs = new Map<string, RenderJob>();
  private readonly queue: string[] = [];
  private activeJobId: string | null = null;
  private acceptingWork = true;

  startRender(slugInput: string): RenderJobView {
    if (!this.acceptingWork) {
      throw new TrackError(
        trackIssue(
          "RENDER_NOT_CANCELLABLE",
          "The server is shutting down and is not accepting new renders.",
        ),
      );
    }

    const slug = assertValidSlug(slugInput);

    // One render per track at a time. Two jobs for the same slug would take the
    // single render slot in turn and write the same out/<slug>.mp4 twice, so the
    // second is only ever wasted work. A client that lost track of its job (a
    // reload, say) should adopt the existing one from GET /api/renders.
    const active = this.activeJobForSlug(slug);
    if (active) {
      throw new TrackError(
        trackIssue(
          "RENDER_ALREADY_ACTIVE",
          `Track "${slug}" is already rendering (job ${active.id}, ${active.status}). Wait for it to finish, or cancel it first.`,
        ),
      );
    }

    const job: RenderJob = {
      id: randomUUID(),
      slug,
      status: "queued",
      progress: 0,
      framesRendered: null,
      totalFrames: null,
      fps: null,
      queuedAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      outputPath: null,
      outputLabel: null,
      error: null,
      logs: [],
      listeners: new Set(),
      child: null,
      cancelRequested: false,
      killTimer: null,
    };

    this.jobs.set(job.id, job);
    this.queue.push(job.id);
    this.appendLog(job, "info", `Queued render for "${slug}".`);
    this.drainQueue();

    return this.toView(job);
  }

  getJob(jobId: string): RenderJobView {
    return this.toView(this.requireJob(jobId));
  }

  /** The queued or running job for a track, if any. */
  private activeJobForSlug(slug: string): RenderJob | undefined {
    return [...this.jobs.values()].find(
      (job) => job.slug === slug && !isTerminalStatus(job.status),
    );
  }

  listJobs(): readonly RenderJobView[] {
    return [...this.jobs.values()]
      .sort((a, b) => b.queuedAt - a.queuedAt)
      .map((job) => this.toView(job));
  }

  getLogs(jobId: string): readonly RenderJobLogEntry[] {
    return [...this.requireJob(jobId).logs];
  }

  /** Subscribe to a job's events; returns an unsubscribe function. */
  subscribe(jobId: string, listener: JobListener): () => void {
    const job = this.requireJob(jobId);
    job.listeners.add(listener);

    return () => {
      job.listeners.delete(listener);
    };
  }

  cancelRender(jobId: string): RenderJobView {
    const job = this.requireJob(jobId);

    if (isTerminalStatus(job.status)) {
      throw new TrackError(
        trackIssue(
          "RENDER_NOT_CANCELLABLE",
          `Render job ${job.id} has already ${job.status} and cannot be cancelled.`,
        ),
      );
    }

    job.cancelRequested = true;

    if (job.status === "queued") {
      const queueIndex = this.queue.indexOf(job.id);
      if (queueIndex !== -1) {
        this.queue.splice(queueIndex, 1);
      }
      this.appendLog(job, "info", "Cancelled before the render started.");
      this.finish(job, "cancelled");
      return this.toView(job);
    }

    this.appendLog(job, "info", "Cancelling render.");

    // Ask the worker to stop gracefully so Remotion can close Chromium and
    // clean up its partial output. Only if that doesn't land do we kill.
    job.child?.send({ type: "cancel" });

    job.killTimer = setTimeout(() => {
      if (job.child && !job.child.killed) {
        this.appendLog(
          job,
          "error",
          "Graceful cancel timed out — terminating the render process.",
        );
        job.child.kill("SIGKILL");
      }
    }, CANCEL_GRACE_MS);
    job.killTimer.unref();

    return this.toView(job);
  }

  /** Stops accepting work and cancels anything in flight. */
  async shutdown(): Promise<void> {
    this.acceptingWork = false;

    for (const jobId of [...this.queue]) {
      const job = this.jobs.get(jobId);
      if (job) {
        this.queue.length = 0;
        this.appendLog(job, "info", "Server shutting down — render cancelled.");
        this.finish(job, "cancelled");
      }
    }

    const activeJob = this.activeJobId ? this.jobs.get(this.activeJobId) : null;
    if (!activeJob?.child) {
      return;
    }

    this.appendLog(activeJob, "info", "Server shutting down — cancelling render.");
    activeJob.cancelRequested = true;
    activeJob.child.send({ type: "cancel" });

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        activeJob.child?.kill("SIGKILL");
        resolve();
      }, CANCEL_GRACE_MS);

      activeJob.child?.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private requireJob(jobId: string): RenderJob {
    const job = this.jobs.get(jobId);

    if (!job) {
      throw new TrackError(
        trackIssue("RENDER_JOB_NOT_FOUND", `Render job "${jobId}" not found.`),
      );
    }

    return job;
  }

  private drainQueue(): void {
    if (this.activeJobId !== null || this.queue.length === 0) {
      return;
    }

    const jobId = this.queue.shift();
    const job = jobId ? this.jobs.get(jobId) : undefined;

    if (!job || job.cancelRequested) {
      // Defensive: cancelRender splices a queued job out itself, so this is not
      // reachable today. Draining again anyway keeps "the queue always makes
      // progress" true unconditionally, rather than depending on that.
      queueMicrotask(() => this.drainQueue());
      return;
    }

    this.activeJobId = job.id;
    job.status = "preparing";
    job.startedAt = Date.now();
    this.emit(job, { type: "status", job: this.toView(job) });

    let child: ChildProcess | null = null;
    let finalized = false;

    // Spawn failure need not emit exit. Both close and exit may fire for a
    // normal process, so slot release must be independent and idempotent.
    const finalize = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finalized) return;
      finalized = true;
      if (job.killTimer) {
        clearTimeout(job.killTimer);
        job.killTimer = null;
      }
      job.child = null;
      if (this.activeJobId === job.id) this.activeJobId = null;

      if (!isTerminalStatus(job.status)) {
        if (job.cancelRequested) {
          this.finish(job, "cancelled");
        } else {
          job.error ??= {
            code: "RENDER_FAILED",
            message: `The render process exited unexpectedly (code ${code ?? "null"}${
              signal ? `, signal ${signal}` : ""
            }).`,
          };
          this.appendLog(job, "error", job.error.message);
          this.finish(job, "failed");
        }
      }
      // Avoid recursive queue draining if several consecutive forks throw.
      queueMicrotask(() => this.drainQueue());
    };

    const onError = (error: Error) => {
      if (finalized) return;
      job.error = {
        code: "RENDER_FAILED",
        message: `The render process failed: ${error.message}`,
        details: error.stack,
      };
      this.appendLog(job, "error", job.error.message);
      // A failed spawn has no PID and might never emit exit. For an error
      // on an existing process (e.g. IPC), keep its slot until it actually exits.
      if (!child?.pid) finalize(null, null);
    };

    try {
      child = fork(WORKER_PATH, [job.slug], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    job.child = child;

    child.on("error", onError);
    child.on("exit", finalize);
    child.on("close", finalize);
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      if (!finalized) this.appendWorkerOutput(job, chunk, "info");
    });
    child.stderr?.on("data", (chunk: string) => {
      if (!finalized) this.appendWorkerOutput(job, chunk, "error");
    });
    child.on("message", (event: WorkerEvent) => {
      if (!finalized && !isTerminalStatus(job.status)) {
        this.handleWorkerEvent(job, event);
      }
    });
  }

  private handleWorkerEvent(job: RenderJob, event: WorkerEvent): void {
    switch (event.type) {
      case "log":
        this.appendLog(job, event.level, event.message);
        break;

      case "status":
        job.status = event.status;
        this.emit(job, { type: "status", job: this.toView(job) });
        break;

      case "resolved":
        job.totalFrames = event.durationInFrames;
        job.fps = event.fps;
        job.outputPath = event.outputPath;
        job.outputLabel = event.outputLabel;
        this.emit(job, { type: "status", job: this.toView(job) });
        break;

      case "progress":
        job.progress = event.progress;
        job.framesRendered = event.renderedFrames;
        this.emit(job, { type: "progress", job: this.toView(job) });
        break;

      case "done":
        job.progress = 1;
        job.outputPath = event.outputPath;
        job.outputLabel = event.outputLabel;
        this.finish(job, "completed");
        break;

      case "cancelled":
        this.finish(job, "cancelled");
        break;

      case "error":
        job.error = event.error;
        this.appendLog(job, "error", event.error.message);
        this.finish(job, "failed");
        break;

      default:
        break;
    }
  }

  private appendWorkerOutput(
    job: RenderJob,
    chunk: string,
    level: "info" | "error",
  ): void {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length > 0) {
        this.appendLog(job, level, trimmed);
      }
    }
  }

  private appendLog(
    job: RenderJob,
    level: "info" | "error",
    message: string,
  ): void {
    const entry: RenderJobLogEntry = {
      at: new Date().toISOString(),
      level,
      message,
    };

    job.logs.push(entry);
    if (job.logs.length > MAX_LOG_ENTRIES) {
      job.logs.splice(0, job.logs.length - MAX_LOG_ENTRIES);
    }

    this.emit(job, { type: "log", entry });
  }

  private finish(job: RenderJob, status: RenderJobStatus): void {
    if (isTerminalStatus(job.status)) {
      return;
    }

    job.status = status;
    job.finishedAt = Date.now();

    const view = this.toView(job);
    if (status === "completed") {
      this.emit(job, { type: "completed", job: view });
    } else if (status === "cancelled") {
      this.emit(job, { type: "cancelled", job: view });
    } else {
      this.emit(job, { type: "failed", job: view });
    }
  }

  private emit(job: RenderJob, event: RenderJobEvent): void {
    for (const listener of job.listeners) {
      listener(event);
    }
  }

  private toView(job: RenderJob): RenderJobView {
    const reference = job.finishedAt ?? Date.now();
    const start = job.startedAt ?? job.queuedAt;

    return {
      id: job.id,
      slug: job.slug,
      status: job.status,
      progress: job.progress,
      framesRendered: job.framesRendered,
      totalFrames: job.totalFrames,
      fps: job.fps,
      elapsedMs: Math.max(0, reference - start),
      startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
      queuedAt: new Date(job.queuedAt).toISOString(),
      finishedAt: job.finishedAt ? new Date(job.finishedAt).toISOString() : null,
      outputPath: job.outputPath,
      outputLabel: job.outputLabel,
      error: job.error,
    };
  }
}

export const renderManager = new RenderManager();
