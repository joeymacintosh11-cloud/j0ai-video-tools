import { readFileSync } from "node:fs";
import path from "node:path";
import {
  parseRenderJournal,
  RENDER_JOURNAL_FILENAME,
  RENDER_JOURNAL_SCHEMA_VERSION,
  selectRetainedEvents,
  type RenderJournalEvent,
  type RenderJournalRead,
} from "../../core/domain/render/renderJournal.ts";
import { appendJsonlLine, withJsonlAppendLock } from "../storage/jsonlAppendLog.ts";
import { withFileMutation, writeAtomicFile } from "../tracks/atomicFile.ts";
import { OUT_DIR } from "../tracks/trackLocations.ts";

/**
 * Reads and appends the durable render journal.
 *
 *   out/.render-journal/journal.jsonl
 *
 * Sibling to `out/.locks`: both are machine-local operational state that
 * lives inside `out/` (already wholly gitignored) but is never rendered
 * *content* — a dot-prefixed directory keeps that distinction visible in a
 * directory listing. Never committed, never placed under `public/` or mixed
 * with a track's own rendered output, per the milestone brief.
 *
 * The append/lock/fsync strategy is the delivery log's — see
 * services/delivery/deliveryHistoryLog.ts for the full reasoning (JSON Lines
 * so a crash can damage at most one line; O_APPEND plus an exclusive
 * cross-process lock plus fsync so a reported append is durable before
 * anything is told so). The primitives themselves now live in
 * services/storage/jsonlAppendLog.ts, shared with the content library's own
 * project-local log; the delivery log keeps its own copy because it lives at
 * an export destination and wraps each step in destination-identity checks.
 *
 * **Why a cross-process lock, when render manager is normally "the" server.**
 * `renderManager` is a plain module singleton, not a network service: several
 * scripts (`scripts/destination-fix-plan.mts` with `--apply --wait`,
 * anything importing `services/workflows/renderManager.ts` directly) run it in
 * their *own* process, forking their own worker and writing their own
 * events, fully independently of whether the API server is running. Two such
 * processes — the API server and a concurrently-run CLI script — can and do
 * append at the same time, so this needs the same real cross-process safety
 * the delivery log has, not merely a same-process queue.
 */

export const RENDER_JOURNAL_DIR = path.join(OUT_DIR, ".render-journal");
const LOCK_FILENAME = ".journal.lock";

/**
 * Resolves the default root fresh on every call, rather than baking it into a
 * load-time constant.
 *
 * `TOSHI_RENDER_JOURNAL_DIR` exists for exactly one consumer: this project's
 * own tests, which redirect it to a throwaway temp directory (see
 * tests/managerHarness.mts) so that exercising `renderManager` — including
 * through a real HTTP server, in tests that never asked for one — never
 * writes into this repository's real `out/.render-journal/`. It is not a
 * general deployment knob; every other call site either takes an explicit
 * `root` or simply wants the one real journal.
 */
const defaultRoot = (): string =>
  process.env.TOSHI_RENDER_JOURNAL_DIR
    ? path.resolve(process.env.TOSHI_RENDER_JOURNAL_DIR)
    : RENDER_JOURNAL_DIR;

export const renderJournalPath = (root: string = defaultRoot()): string =>
  path.join(root, RENDER_JOURNAL_FILENAME);
const withAppendLock = <T>(root: string, operation: () => Promise<T>): Promise<T> =>
  withJsonlAppendLock({ root, lockFilename: LOCK_FILENAME, label: "render journal" }, operation);

/** The whole journal, parsed. Small by design (see retention) — read in one go. */
export const readRenderJournal = (root: string = defaultRoot()): RenderJournalRead => {
  const file = renderJournalPath(root);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", events: [], problems: [], lines: 0, endsWithNewline: true };
    }
    throw error;
  }
  return parseRenderJournal(text);
};

export type AppendRenderJournalResult = {
  readonly appended: boolean;
  readonly problem: string | null;
};

/**
 * Appends one lifecycle event, durably.
 *
 * Never throws: a render's own lifecycle must never fail because its audit
 * trail could not be written (§40/§41 of the milestone brief — this is
 * evidence, not execution authority). Callers get a result and are expected
 * to log a problem, not propagate it into the render.
 */
export const appendRenderJournalEvent = async (
  event: RenderJournalEvent,
  root: string = defaultRoot(),
): Promise<AppendRenderJournalResult> => {
  try {
    const file = renderJournalPath(root);
    return await withFileMutation(file, () =>
      withAppendLock(root, async () => {
        const existing = readRenderJournal(root);
        const needsNewline = !existing.endsWithNewline;
        const line = `${needsNewline ? "\n" : ""}${JSON.stringify(event)}\n`;
        await appendJsonlLine(file, line);
        return { appended: true, problem: null };
      }),
    );
  } catch (error) {
    return { appended: false, problem: error instanceof Error ? error.message : String(error) };
  }
};

export type RepairRenderJournalTailResult = {
  readonly repaired: boolean;
  readonly discarded: string | null;
  readonly problem: string | null;
};

/** Drops an incomplete final line, and nothing else. Mirrors repairDeliveryLogTail. */
export const repairRenderJournalTail = async (
  root: string = defaultRoot(),
): Promise<RepairRenderJournalTailResult> => {
  const file = renderJournalPath(root);

  return withFileMutation(file, () =>
    withAppendLock(root, async () => {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        return {
          repaired: false,
          discarded: null,
          problem:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "There is no render journal yet, so there is nothing to repair."
              : `The render journal could not be read: ${(error as Error).message}`,
        };
      }

      const read = parseRenderJournal(text);
      if (read.status !== "recovered_tail") {
        return {
          repaired: false,
          discarded: null,
          problem:
            read.status === "complete" || read.status === "missing"
              ? "The render journal has no incomplete final line, so there is nothing to repair."
              : `The render journal reads as "${read.status}", which this repair deliberately will not touch. Inspect ${file} first.`,
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

export type CompactRenderJournalResult = {
  readonly compacted: boolean;
  readonly before: number;
  readonly after: number;
  readonly problem: string | null;
};

/**
 * Rewrites the journal to keep only what §33/§34 of the brief say must
 * survive: every event for a still-open (non-terminal) job, and one event —
 * the accepted terminal one — per terminal job within the retention window.
 *
 * Never runs automatically; an operator or `scripts/render-journal.mts
 * --compact` asks for it explicitly. Refuses on `corrupt`/`unsupported`
 * exactly like tail repair refuses: compacting on top of damage this tool
 * cannot fully read risks discarding events it failed to parse rather than
 * events retention actually decided to drop.
 */
export const compactRenderJournal = async (
  root: string = defaultRoot(),
  now: Date = new Date(),
): Promise<CompactRenderJournalResult> => {
  const file = renderJournalPath(root);

  return withFileMutation(file, () =>
    withAppendLock(root, async () => {
      let text: string;
      try {
        text = readFileSync(file, "utf8");
      } catch (error) {
        return {
          compacted: false,
          before: 0,
          after: 0,
          problem:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "There is no render journal yet, so there is nothing to compact."
              : `The render journal could not be read: ${(error as Error).message}`,
        };
      }

      const read = parseRenderJournal(text);
      if (read.status === "corrupt" || read.status === "unsupported") {
        return {
          compacted: false,
          before: read.events.length,
          after: read.events.length,
          problem: `The render journal reads as "${read.status}" and will not be compacted on top of unread damage. Inspect ${file} first.`,
        };
      }

      const retained = selectRetainedEvents(read.events, now);
      if (retained.length === read.events.length) {
        return { compacted: false, before: read.events.length, after: read.events.length, problem: null };
      }

      const body = retained.map((event) => `${JSON.stringify(event)}\n`).join("");
      await writeAtomicFile(file, (handle) => handle.writeFile(body, "utf-8"));

      return { compacted: true, before: read.events.length, after: retained.length, problem: null };
    }),
  );
};

export const RENDER_JOURNAL_SCHEMA = RENDER_JOURNAL_SCHEMA_VERSION;
