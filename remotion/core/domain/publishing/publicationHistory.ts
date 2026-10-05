import type { RendererId } from "../video/renderers.ts";
import type { RenderPresetId } from "../video/renderPresets.ts";
import { parsePublicationReceipt, type PublicationReceipt } from "./publicationReceipt.ts";

/**
 * The publication history: every receipt, read from the append-only receipt
 * log. Pure parsing and querying, like the delivery log and content library.
 *
 * A malformed line is reported with its line number and never hides the rest.
 * A second receipt for the same receipt id, attempt or job is reported as a
 * duplicate and ignored — nothing the engine does can write one, so seeing
 * one means the file was edited or damaged.
 */

export const PUBLICATION_RECEIPTS_FILENAME = "receipts.jsonl";

export type PublicationHistoryProblem = {
  readonly line: number;
  readonly kind: "malformed" | "invalid" | "duplicate" | "truncated";
  readonly message: string;
};

export type PublicationHistoryRead = {
  readonly status: "missing" | "complete" | "damaged";
  readonly receipts: readonly PublicationReceipt[];
  readonly problems: readonly PublicationHistoryProblem[];
  readonly endsWithNewline: boolean;
};

export const parsePublicationHistory = (text: string): PublicationHistoryRead => {
  const receipts: PublicationReceipt[] = [];
  const problems: PublicationHistoryProblem[] = [];
  const seen = { receipt: new Set<string>(), attempt: new Set<string>(), job: new Set<string>() };
  const endsWithNewline = text.length === 0 || text.endsWith("\n");
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();

  lines.forEach((line, index) => {
    const number = index + 1;
    if (line.trim().length === 0) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      const last = index === lines.length - 1 && !endsWithNewline;
      problems.push({ line: number, kind: last ? "truncated" : "malformed", message: last ? "Incomplete final line." : "Not valid JSON." });
      return;
    }
    const parsed = parsePublicationReceipt(value);
    if (parsed.receipt === null) {
      problems.push({ line: number, kind: "invalid", message: `Invalid receipt: ${parsed.problem}.` });
      return;
    }
    const receipt = parsed.receipt;
    if (seen.receipt.has(receipt.receiptId) || seen.attempt.has(receipt.attemptId) || seen.job.has(receipt.jobId)) {
      problems.push({ line: number, kind: "duplicate", message: `A second receipt for job ${receipt.jobId}; ignored.` });
      return;
    }
    seen.receipt.add(receipt.receiptId);
    seen.attempt.add(receipt.attemptId);
    seen.job.add(receipt.jobId);
    receipts.push(receipt);
  });

  return { status: problems.length === 0 ? "complete" : "damaged", receipts, problems, endsWithNewline };
};

export type PublicationHistoryQuery = {
  readonly track?: string;
  readonly destination?: string;
  readonly format?: RenderPresetId;
  readonly renderer?: RendererId;
  readonly limit?: number;
};

export const PUBLICATION_HISTORY_MAX_LIMIT = 500;

/** Newest first. */
export const queryPublicationHistory = (
  receipts: readonly PublicationReceipt[],
  query: PublicationHistoryQuery = {},
): readonly PublicationReceipt[] =>
  receipts
    .filter(
      (receipt) =>
        (query.track === undefined || receipt.source.slug === query.track) &&
        (query.destination === undefined || receipt.destination.id === query.destination) &&
        (query.format === undefined || receipt.source.presetId === query.format) &&
        (query.renderer === undefined || receipt.source.renderer === query.renderer),
    )
    .slice()
    .sort((a, b) => b.recordedAt.localeCompare(a.recordedAt))
    .slice(0, Math.min(query.limit ?? 50, PUBLICATION_HISTORY_MAX_LIMIT));
