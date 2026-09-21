import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";

/**
 * Redirects the render journal to a throwaway directory for one whole test
 * file, so a test that exercises the real `renderManager` singleton directly
 * (rather than through tests/managerHarness.mts's per-test isolated import)
 * never writes into this repository's real `out/.render-journal/`.
 *
 * File-scoped rather than per-test on purpose: `renderManager` fires journal
 * writes without awaiting them (see server/services/renderJournal.ts), so a
 * write can still be in flight when one test ends. Removing the directory
 * only once, after every test in the file has finished, means there is
 * nothing to race.
 *
 * `await`ed at module top level by every caller (top-level await in an ESM
 * test file blocks the test runner from registering — let alone running —
 * any `test(...)` in that file until this resolves), so the redirect is
 * guaranteed to be in place before the very first render this file starts.
 */
export const isolateRenderJournalForThisFile = async (): Promise<void> => {
  const previous = process.env.TOSHI_RENDER_JOURNAL_DIR;
  const dir = await mkdtemp(path.join(tmpdir(), "toshi-render-journal-test-"));
  process.env.TOSHI_RENDER_JOURNAL_DIR = dir;

  after(async () => {
    // Wait for every journal write this file caused to actually land before
    // touching env or the directory — a fixed delay was tried first and was
    // not reliable (see tests/managerHarness.mts's identical fix for why: an
    // in-flight write's own mkdirSync would silently recreate the directory
    // right after removal).
    const { waitForRenderJournalIdle } = await import("../server/services/renderJournal.ts");
    await waitForRenderJournalIdle();
    if (previous === undefined) delete process.env.TOSHI_RENDER_JOURNAL_DIR;
    else process.env.TOSHI_RENDER_JOURNAL_DIR = previous;
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
};
