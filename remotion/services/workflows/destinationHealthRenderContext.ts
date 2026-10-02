import {
  describeRenderContext,
  RENDER_CONTEXT_ELIGIBLE_CODES,
  type DestinationFinding,
} from "../../core/domain/delivery/destinationHealth.ts";
import {
  buildMostRecentJobIndex,
  reconstructRenderJournal,
  targetKey,
  type RecoveredRenderJob,
} from "../../core/domain/render/renderJournal.ts";
import { readRenderJournal } from "../render/renderJournalLog.ts";
import type { DestinationHealthResult } from "./destinationHealth.ts";
import { RENDER_MANAGER_BOOT_ID } from "./renderJournal.ts";
import { renderManager } from "./renderManager.ts";

/**
 * Attaches optional, explanatory-only render history to destination-health
 * findings, after `scanDestinationHealth` has already decided what is
 * wrong — never before, and never in a way that changes what it decided.
 *
 * Architecture boundary (the one this whole milestone exists to respect):
 * destination health answers "what is wrong with the destination right
 * now?"; the render journal answers "what happened to prior render jobs?".
 * This module composes the two answers, the same way
 * `server/routes/renderHistory.ts` composes `renderManager` and the journal
 * for `GET /api/render-history` — it is not part of either authority. It
 * never creates, removes, or changes the severity of a finding; it only
 * ever adds a `renderContext` field to a finding that already exists,
 * exactly as `scanDestinationHealth` produced it. `services/workflows/
 * destinationFixPlan.ts` calls `scanDestinationHealth` directly and never
 * this function, which is what makes "the fix planner is unaffected by
 * render context" true by construction rather than by convention (§22 of
 * the milestone this implements) — the planner's findings simply never
 * carry the field at all.
 */

const isEligible = (
  finding: DestinationFinding,
): finding is DestinationFinding & { slug: string; presetId: string } =>
  finding.slug !== null &&
  finding.presetId !== null &&
  RENDER_CONTEXT_ELIGIBLE_CODES.has(finding.code) &&
  finding.renderContext === undefined;

const anyEligible = (result: DestinationHealthResult): boolean =>
  result.tracks.some((track) => track.findings.some(isEligible));

const attach = (
  finding: DestinationFinding,
  index: ReadonlyMap<string, RecoveredRenderJob>,
  liveTargetKeys: ReadonlySet<string>,
): DestinationFinding => {
  if (!isEligible(finding)) return finding;

  const key = targetKey(finding.slug, finding.presetId);
  // A target currently rendering right now must never show *any* historical
  // context, not merely avoid misclassifying the live job itself — an
  // older, genuinely dead job's "interrupted"/"failed" would otherwise still
  // read as the current story while a fresh attempt is actively under way.
  // Health has no live-state field of its own to show instead (§9/§40 of
  // the milestone this implements: "use existing live state if health
  // already knows it, otherwise omit context") — RenderPanel's live state
  // elsewhere on the page is what actually answers "what's happening now".
  if (liveTargetKeys.has(key)) return finding;

  const job = index.get(key);
  if (job === undefined) return finding;

  // classifyRecoveredJob (core/domain/render/renderJournal.ts) never actually
  // produces "queued"/"preparing"/"rendering" — its own comment guarantees
  // every non-terminal record becomes "interrupted" instead — but its type
  // is the wider RenderJournalLifecycleState union rather than a narrowed
  // one. "completed" is excluded deliberately (see
  // DestinationFindingRenderContext's own comment: it has no explanatory
  // value here); the other three non-terminal literals are excluded
  // defensively, for the same reason — never as documentation of a real
  // code path.
  if (job.status !== "failed" && job.status !== "cancelled" && job.status !== "interrupted") {
    return finding;
  }

  return {
    ...finding,
    renderContext: {
      jobId: job.jobId,
      state: job.status,
      recordedAt: job.recordedAt,
      presetId: finding.presetId,
      // Only `.message` is read — never spread the whole error object. A
      // live job's error may carry a `details` field (a raw stack trace;
      // see renderManager.ts's own comment on why the *journal's* own copy
      // of an error is already stripped of it before it is ever written)
      // that has no business reaching this sentence even if some future
      // change to the journal's schema ever allowed it through again.
      note: describeRenderContext(
        job.status,
        job.error === null ? null : { message: job.error.message },
      ),
    },
  };
};

export const enrichDestinationHealthWithRenderContext = (
  result: DestinationHealthResult,
): DestinationHealthResult => {
  // No eligible finding at all: skip the journal read entirely rather than
  // reconstructing it only to find nothing to attach (§16 of the milestone
  // this implements — the common "healthy" or root-only-finding scan never
  // touches the journal).
  if (!anyEligible(result)) return result;

  try {
    const read = readRenderJournal();
    const reconstruction = reconstructRenderJournal(read.events);
    const liveJobs = renderManager.listJobs();
    // Live always wins (§9): a job renderManager currently holds live is
    // never eligible to become anyone's "most recent" answer, the same
    // boundary GET /api/render-history already enforces at the list level.
    const liveJobIds = new Set(liveJobs.map((job) => job.id));
    const liveTargetKeys = new Set(
      liveJobs.map((job) => targetKey(job.slug, job.presetId)),
    );
    const index = buildMostRecentJobIndex(reconstruction, RENDER_MANAGER_BOOT_ID, liveJobIds);

    return {
      ...result,
      tracks: result.tracks.map((track) => ({
        ...track,
        findings: track.findings.map((finding) => attach(finding, index, liveTargetKeys)),
      })),
    };
  } catch {
    // A journal that cannot be read at all (a real fs error beyond the
    // ordinary "no file yet") must never fail destination health — this is
    // explanatory context, not part of what the scan itself decided (§17 of
    // the milestone this implements). The unenriched result is exactly as
    // valid as it was before this function was called.
    return result;
  }
};
