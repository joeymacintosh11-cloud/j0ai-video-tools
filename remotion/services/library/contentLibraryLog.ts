import path from "node:path";
import {
  CONTENT_LIBRARY_FILENAME,
  parseContentLibrary,
  type ContentLibraryRead,
  type ContentLibraryRecord,
} from "../../core/domain/library/contentLibrary.ts";
import {
  appendJsonlLine,
  readTextIfPresent,
  releaseJsonlLock,
  withJsonlAppendLock,
  type ReleaseJsonlLockResult,
} from "../storage/jsonlAppendLog.ts";
import { withFileMutation, writeAtomicFile } from "../tracks/atomicFile.ts";
import { OUT_DIR } from "../tracks/trackLocations.ts";

/**
 * Reads and appends the content library.
 *
 *   out/.content-library/library.jsonl
 *
 * Beside `out/.render-journal/` and for the same reasons: it describes the
 * exports under `out/` (already wholly gitignored), it is machine-local, and a
 * dot-prefixed directory keeps it visibly apart from rendered content. It
 * lives and dies with the exports it describes.
 *
 * Append-only: nothing in normal operation rewrites a record. The only
 * rewrite is `repairContentLibraryTail`, which an operator runs explicitly
 * and which can only ever drop an already-unparseable final fragment.
 *
 * Appending never fails the caller: the export it describes is already
 * published, and a record that could not be written is a reportable problem,
 * not a reason to disown a finished file.
 */

export const CONTENT_LIBRARY_DIR = path.join(OUT_DIR, ".content-library");
const LOCK_FILENAME = ".library.lock";
const LABEL = "content library";
const HINT = "If nothing is running, clear it with: npm run content-library -- --release-lock";

/**
 * Resolved on every call rather than baked into a constant, so a test can
 * redirect it (`TOSHI_CONTENT_LIBRARY_DIR`) and never write into this
 * repository's real library — the same convention as the render journal's
 * `TOSHI_RENDER_JOURNAL_DIR`. A forked render worker inherits it.
 */
export const contentLibraryRoot = (): string =>
  process.env.TOSHI_CONTENT_LIBRARY_DIR
    ? path.resolve(process.env.TOSHI_CONTENT_LIBRARY_DIR)
    : CONTENT_LIBRARY_DIR;

export const contentLibraryPath = (root: string = contentLibraryRoot()): string =>
  path.join(root, CONTENT_LIBRARY_FILENAME);

const withAppendLock = <T>(root: string, operation: () => Promise<T>): Promise<T> =>
  withJsonlAppendLock({ root, lockFilename: LOCK_FILENAME, label: LABEL, hint: HINT }, operation);

/** The whole library, parsed. One read; a year of daily renders is well under a megabyte. */
export const readContentLibrary = (root: string = contentLibraryRoot()): ContentLibraryRead => {
  const text = readTextIfPresent(contentLibraryPath(root));
  if (text === null) {
    return { status: "missing", records: [], problems: [], lines: 0, endsWithNewline: true };
  }
  return parseContentLibrary(text);
};

export type AppendContentLibraryResult = {
  readonly appended: boolean;
  /** Set when a record with the same id was already there, so nothing was written. */
  readonly duplicate: boolean;
  readonly record: ContentLibraryRecord | null;
  readonly problem: string | null;
};

/**
 * Appends one record, built from the library as it stands under the lock.
 *
 * `build` receives the records already there, so anything a record says about
 * its predecessors (which record it replaced) is decided against the same
 * contents the append lands on — never against a read that another process
 * could have appended past in the meantime. The duplicate check happens under
 * the same lock, so a retried completion step cannot record one export twice.
 */
export const appendContentLibraryRecord = async (
  build: (existing: readonly ContentLibraryRecord[]) => ContentLibraryRecord,
  root: string = contentLibraryRoot(),
): Promise<AppendContentLibraryResult> => {
  try {
    const file = contentLibraryPath(root);
    return await withFileMutation(file, () =>
      withAppendLock(root, async () => {
        const existing = readContentLibrary(root);
        const record = build(existing.records);

        if (existing.records.some((recorded) => recorded.recordId === record.recordId)) {
          return { appended: false, duplicate: true, record, problem: null };
        }

        // Terminate an unterminated final line first, so the new record always
        // lands whole on a line of its own (see deliveryHistoryLog.ts).
        const line = `${existing.endsWithNewline ? "" : "\n"}${JSON.stringify(record)}\n`;
        await appendJsonlLine(file, line);
        return { appended: true, duplicate: false, record, problem: null };
      }),
    );
  } catch (error) {
    return {
      appended: false,
      duplicate: false,
      record: null,
      problem: error instanceof Error ? error.message : String(error),
    };
  }
};

export type RepairContentLibraryResult = {
  readonly repaired: boolean;
  /** The bytes dropped, so an operator can see what was lost. */
  readonly discarded: string | null;
  readonly problem: string | null;
};

/**
 * Drops an incomplete final line, and nothing else — only when the library
 * reads as `recovered_tail`. Damage anywhere else is left exactly as it is.
 * Held under the append lock because it replaces the file.
 */
export const repairContentLibraryTail = async (
  root: string = contentLibraryRoot(),
): Promise<RepairContentLibraryResult> => {
  const file = contentLibraryPath(root);

  return withFileMutation(file, () =>
    withAppendLock(root, async () => {
      let text: string | null;
      try {
        text = readTextIfPresent(file);
      } catch (error) {
        return {
          repaired: false,
          discarded: null,
          problem: `The content library could not be read: ${(error as Error).message}`,
        };
      }

      if (text === null) {
        return {
          repaired: false,
          discarded: null,
          problem: "There is no content library yet, so there is nothing to repair.",
        };
      }

      const read = parseContentLibrary(text);
      if (read.status !== "recovered_tail") {
        return {
          repaired: false,
          discarded: null,
          problem:
            read.status === "complete" || read.status === "missing"
              ? "The content library has no incomplete final line, so there is nothing to repair."
              : `The content library reads as "${read.status}", which this repair deliberately will not touch. Inspect ${file} first.`,
        };
      }

      const lastNewline = text.lastIndexOf("\n");
      const keep = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
      const discarded = text.slice(lastNewline + 1);
      await writeAtomicFile(file, (handle) => handle.writeFile(keep, "utf-8"));
      return { repaired: true, discarded, problem: null };
    }),
  );
};

/** The operator path for a lock nothing can explain; see releaseJsonlLock. */
export const releaseContentLibraryLock = (
  root: string = contentLibraryRoot(),
): ReleaseJsonlLockResult => releaseJsonlLock(root, LOCK_FILENAME, LABEL);
