import { createHash, randomBytes, randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import path from "node:path";
import {
  parsePublicationHistory,
  PUBLICATION_RECEIPTS_FILENAME,
  type PublicationHistoryRead,
} from "../../core/domain/publishing/publicationHistory.ts";
import type { PublicationReceipt } from "../../core/domain/publishing/publicationReceipt.ts";
import {
  attemptIdentityText,
  PUBLISH_JOB_ID_PATTERN,
  PUBLISH_JOB_SCHEMA_VERSION,
  PUBLISH_JOB_STATES,
  type PublishJob,
} from "../../core/domain/publishing/publishJob.ts";
import { isPublicationSourceIdentity } from "../../core/domain/publishing/publicationSource.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { appendJsonlLine, readTextIfPresent, withJsonlAppendLock } from "../storage/jsonlAppendLog.ts";
import { withFileMutation, writeAtomicFile } from "../tracks/atomicFile.ts";
import { OUT_DIR } from "../tracks/trackLocations.ts";

/**
 * Where publishing keeps its state, and the only code that touches it.
 *
 *   out/.publishing/
 *     jobs/<jobId>.json          one publish job, rewritten atomically per transition
 *     locks/<jobId>.lock         held while a process executes or settles that job
 *     receipts.jsonl             append-only publication receipts (the history)
 *     destinations/<id>/...      a local adapter's own workspace (the mock's)
 *
 * Beside out/.content-library and out/.render-journal, for the same reasons:
 * machine-local, gitignored with the exports it describes, and visibly apart
 * from rendered content. Nothing here is written into an export's folder, its
 * manifest, the content library or a delivery receipt.
 *
 * `TOSHI_PUBLISHING_DIR` redirects it (tests), the same convention as
 * `TOSHI_CONTENT_LIBRARY_DIR`.
 */

export const PUBLISHING_DIR = path.join(OUT_DIR, ".publishing");

export const publishingRoot = (): string =>
  process.env.TOSHI_PUBLISHING_DIR ? path.resolve(process.env.TOSHI_PUBLISHING_DIR) : PUBLISHING_DIR;

const jobsDir = (root: string) => path.join(root, "jobs");
const locksDir = (root: string) => path.join(root, "locks");
export const receiptsPath = (root: string = publishingRoot()) => path.join(root, PUBLICATION_RECEIPTS_FILENAME);

/** Where a local destination adapter may keep its own files. */
export const destinationWorkspace = (destinationId: string, root: string = publishingRoot()): string =>
  path.join(root, "destinations", destinationId);

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/* ------------------------------------------------------------------ *
 * Identities
 * ------------------------------------------------------------------ */

export const newPublishJobId = (): string => `pub_${randomBytes(12).toString("hex")}`;

/** Deterministic per (job, attempt number): a resumed attempt keeps its key, a retry gets a new one. */
export const attemptIdentity = (jobId: string, attemptNumber: number) => {
  const idempotencyKey = sha256(attemptIdentityText(jobId, attemptNumber));
  return { attemptId: `att_${idempotencyKey.slice(0, 24)}`, idempotencyKey };
};

/** One attempt can only ever have one receipt id. */
export const receiptIdFor = (idempotencyKey: string): string =>
  `rcp_${sha256(`toshi-publication-receipt\u0000${idempotencyKey}`).slice(0, 24)}`;

/* ------------------------------------------------------------------ *
 * Jobs
 * ------------------------------------------------------------------ */

const assertJobId = (jobId: string): string => {
  if (!PUBLISH_JOB_ID_PATTERN.test(jobId))
    throw new TrackError(trackIssue("PUBLISH_JOB_NOT_FOUND", `Publish job "${jobId}" not found.`));
  return jobId;
};

const jobPath = (jobId: string, root: string) => path.join(jobsDir(root), `${assertJobId(jobId)}.json`);

const isStoredJob = (value: unknown): value is PublishJob => {
  const v = value as PublishJob | null;
  return (
    v !== null &&
    typeof v === "object" &&
    v.schemaVersion === PUBLISH_JOB_SCHEMA_VERSION &&
    PUBLISH_JOB_ID_PATTERN.test(v.jobId) &&
    PUBLISH_JOB_STATES.includes(v.state) &&
    typeof v.destinationId === "string" &&
    (v.source === null || isPublicationSourceIdentity(v.source)) &&
    Array.isArray(v.attempts) &&
    Array.isArray(v.history) &&
    typeof v.metadata === "object"
  );
};

export const readPublishJobFile = (jobId: string, root: string = publishingRoot()): PublishJob => {
  let text: string;
  try {
    text = readFileSync(jobPath(jobId, root), "utf8");
  } catch {
    throw new TrackError(trackIssue("PUBLISH_JOB_NOT_FOUND", `Publish job "${jobId}" not found.`));
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    value = null;
  }
  if (!isStoredJob(value) || value.jobId !== jobId)
    throw new Error(`Publish job file for "${jobId}" is unreadable or invalid; it is left untouched for inspection.`);
  return value;
};

export const writePublishJobFile = async (job: PublishJob, root: string = publishingRoot()): Promise<void> => {
  await mkdir(jobsDir(root), { recursive: true });
  const file = jobPath(job.jobId, root);
  await withFileMutation(file, () =>
    writeAtomicFile(file, (handle) => handle.writeFile(`${JSON.stringify(job, null, 2)}\n`, "utf8")),
  );
};

export type StoredJobs = {
  readonly jobs: readonly PublishJob[];
  readonly problems: readonly { readonly file: string; readonly message: string }[];
};

export const listPublishJobFiles = (root: string = publishingRoot()): StoredJobs => {
  let names: string[];
  try {
    names = readdirSync(jobsDir(root)).filter((name) => name.endsWith(".json"));
  } catch {
    return { jobs: [], problems: [] };
  }
  const jobs: PublishJob[] = [];
  const problems: { file: string; message: string }[] = [];
  for (const name of names) {
    const jobId = name.slice(0, -".json".length);
    try {
      jobs.push(readPublishJobFile(jobId, root));
    } catch (error) {
      problems.push({ file: `jobs/${name}`, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { jobs, problems };
};

/* ------------------------------------------------------------------ *
 * Execution lock: one process at a time may execute or settle a job
 * ------------------------------------------------------------------ */

type LockOwner = { readonly pid: number; readonly hostname: string; readonly token: string; readonly createdAt: string };

const lockPath = (jobId: string, root: string) => path.join(locksDir(root), `${assertJobId(jobId)}.lock`);

const readLockOwner = (file: string): LockOwner | null => {
  try {
    const owner = JSON.parse(readFileSync(file, "utf8")) as LockOwner;
    return typeof owner?.token === "string" && Number.isInteger(owner.pid) && typeof owner.hostname === "string" ? owner : null;
  } catch {
    return null;
  }
};

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

export type JobLockState = "free" | "held" | "abandoned";

/**
 * free: nobody; held: a live local process or another host (which cannot be
 * judged, so it counts as held); abandoned: a dead process on this host.
 */
export const inspectJobLock = (jobId: string, root: string = publishingRoot()): JobLockState => {
  const file = lockPath(jobId, root);
  let present = true;
  try {
    readFileSync(file);
  } catch {
    present = false;
  }
  if (!present) return "free";
  const owner = readLockOwner(file);
  if (owner === null) return "held"; // Written whole or not at all; unreadable means mid-write.
  if (owner.hostname !== hostname()) return "held";
  return alive(owner.pid) ? "held" : "abandoned";
};

export type JobLock = { readonly release: () => void };

/** Refuses immediately rather than waiting: a held job is being worked on elsewhere. */
export const acquireJobLock = (jobId: string, root: string = publishingRoot()): JobLock => {
  mkdirSync(locksDir(root), { recursive: true });
  const file = lockPath(jobId, root);
  const token = randomUUID();
  const write = () => {
    const fd = openSync(file, "wx");
    try {
      writeSync(fd, JSON.stringify({ pid: process.pid, hostname: hostname(), token, createdAt: new Date().toISOString() }));
    } finally {
      closeSync(fd);
    }
  };
  try {
    write();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (inspectJobLock(jobId, root) !== "abandoned")
      throw new TrackError(trackIssue("PUBLISH_JOB_CONFLICT", `Publish job ${jobId} is being worked on by another process.`));
    // Serialize reclaimers: otherwise a second contender can unlink the
    // first contender's new live lock after both observed the dead owner.
    const guard = `${file}.reclaim`;
    let guardFd: number;
    try {
      guardFd = openSync(guard, "wx");
    } catch {
      throw new TrackError(trackIssue("PUBLISH_JOB_CONFLICT", `Publish job ${jobId} ownership is being reconciled. Try again later.`));
    }
    try {
      // Recheck while fenced, never act on the pre-guard observation.
      if (inspectJobLock(jobId, root) === "abandoned") unlinkSync(file);
    } finally {
      closeSync(guardFd);
      unlinkSync(guard);
    }
    try {
      write();
    } catch {
      throw new TrackError(trackIssue("PUBLISH_JOB_CONFLICT", `Publish job ${jobId} is being worked on by another process.`));
    }
  }
  return {
    release: () => {
      try {
        if (readLockOwner(file)?.token === token) unlinkSync(file);
      } catch {
        // Already gone.
      }
    },
  };
};

/* ------------------------------------------------------------------ *
 * Receipts: append-only history
 * ------------------------------------------------------------------ */

const RECEIPT_LOCK = ".receipts.lock";

export const readPublicationReceipts = (root: string = publishingRoot()): PublicationHistoryRead => {
  const text = readTextIfPresent(receiptsPath(root));
  if (text === null) return { status: "missing", receipts: [], problems: [], endsWithNewline: true };
  return parsePublicationHistory(text);
};

export type AppendReceiptResult =
  | { readonly appended: true; readonly receipt: PublicationReceipt }
  /** The same attempt's receipt was already recorded: idempotent, nothing written. */
  | { readonly appended: false; readonly receipt: PublicationReceipt };

/**
 * Appends a receipt unless this attempt already has one. A *different*
 * receipt for the same job (another attempt) is refused outright: one job,
 * at most one publication.
 */
export const appendPublicationReceipt = async (
  receipt: PublicationReceipt,
  root: string = publishingRoot(),
): Promise<AppendReceiptResult> => {
  const file = receiptsPath(root);
  return withFileMutation(file, () =>
    withJsonlAppendLock({ root, lockFilename: RECEIPT_LOCK, label: "publication receipt log" }, async () => {
      const existing = readPublicationReceipts(root);
      const same = existing.receipts.find((entry) => entry.attemptId === receipt.attemptId || entry.receiptId === receipt.receiptId);
      if (same !== undefined) {
        if (same.receiptId !== receipt.receiptId || same.jobId !== receipt.jobId || same.publicationId !== receipt.publicationId)
          throw new Error("A conflicting receipt is already recorded for this attempt.");
        return { appended: false, receipt: same };
      }
      if (existing.receipts.some((entry) => entry.jobId === receipt.jobId))
        throw new Error(`Job ${receipt.jobId} already has a publication receipt; a second one is refused.`);
      await appendJsonlLine(file, `${existing.endsWithNewline ? "" : "\n"}${JSON.stringify(receipt)}\n`);
      return { appended: true, receipt };
    }),
  );
};
