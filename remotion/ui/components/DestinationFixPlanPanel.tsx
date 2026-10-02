import { useEffect, useRef, useState } from "react";
import type {
  DestinationFixApplyView,
  DestinationFixPlanView,
  RemediationAction,
  RemediationActionResult,
} from "../../core/domain/api/views.ts";
import { ApiRequestError, applyDestinationFix, planDestinationFix } from "../api/client.ts";
import { useRenderJob } from "../hooks/useRenderJob.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

const RESULT_LABEL: Record<RemediationActionResult["status"], string> = {
  completed: "Done",
  skipped_already_fixed: "Already fixed",
  queued: "Queued",
  render_failed: "Render failed",
  delivery_failed: "Delivery failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  blocked: "Blocked",
  failed: "Failed",
  manual: "Manual",
};

const ActionRow: React.FC<{
  readonly action: RemediationAction;
  readonly selectable: boolean;
  readonly selected?: boolean;
  readonly onToggle?: () => void;
  readonly busy: boolean;
}> = ({ action, selectable, selected = false, onToggle, busy }) => (
  <li className="fixplan__action">
    <label className="fixplan__actionlabel">
      {selectable ? (
        <input type="checkbox" checked={selected} disabled={busy} onChange={onToggle} />
      ) : (
        <span className="fixplan__mark" aria-hidden="true">
          !
        </span>
      )}
      <span>
        <span className="fixplan__title">{action.title}</span>
        <span className="muted"> — {action.reason}</span>
      </span>
    </label>
  </li>
);

const ResultRow: React.FC<{ readonly result: RemediationActionResult }> = ({ result }) => {
  const tone =
    result.status === "completed" || result.status === "skipped_already_fixed"
      ? "info"
      : result.status === "failed" ||
          result.status === "blocked" ||
          result.status === "render_failed" ||
          result.status === "delivery_failed" ||
          result.status === "cancelled"
        ? "error"
        : "warning";
  const where = [result.slug, result.presetId].filter((part) => part !== null).join(" / ");
  return (
    <li className={`note note--${tone}`}>
      <span className="note__message">
        [{RESULT_LABEL[result.status]}] {result.kind}
        {where ? ` — ${where}` : ""}
        {result.reason ? `: ${result.reason}` : ""}
        {result.healthConfirmed === true ? " (destination health confirmed)" : ""}
      </span>
    </li>
  );
};

/**
 * A render job's live status, for one action currently being followed —
 * reuses the existing per-job SSE hook, the exact same one the render panel
 * elsewhere in the app uses. No second progress source.
 */
const FollowedRender: React.FC<{
  readonly title: string;
  readonly jobId: string;
  readonly onSettled: () => void;
}> = ({ title, jobId, onSettled }) => {
  const { job, missing } = useRenderJob(jobId, onSettled);
  useEffect(() => {
    if (missing) onSettled();
  }, [missing, onSettled]);

  const label =
    job === null
      ? missing ? "Job no longer available" : "Queued"
      : job.status === "queued"
        ? "Queued"
        : job.status === "preparing"
          ? "Preparing"
          : job.status === "rendering"
            ? `Rendering ${Math.round(job.progress * 100)}%`
            : job.status;

  return (
    <li className="fixplan__action">
      <span className="fixplan__title">{title}</span>
      <span className="muted"> — {label}</span>
    </li>
  );
};

/**
 * Turns destination drift into a reviewed, typed remediation plan — and, only
 * on request, runs the safe actions in it.
 *
 * Always two explicit steps: "Create fix plan" only ever proposes (it re-runs
 * a destination health scan itself, so it never depends on one having already
 * run), and nothing is executed until the safe actions to run are selected and
 * "Apply" is pressed. Manual-review items are shown for visibility but are
 * never selectable — nothing here ever deletes or replaces a file it did not
 * itself deliver.
 *
 * A rerender_and_deliver action queues its render, then never merely implies
 * success: this panel follows the job it was given through the existing
 * per-job SSE endpoint (the same one the render UI already uses) and, once it
 * settles, automatically calls apply-plan a second time with
 * `waitForCompletion` and the exact action/job pairs — which re-derives
 * everything fresh, delivers the
 * export now that its render is real, and returns the actually-confirmed
 * final outcome. Reusing the render job's own progress this way means no
 * second progress transport is needed here at all.
 */
export const DestinationFixPlanPanel: React.FC<{
  readonly tracks: readonly string[] | null;
  readonly disabled?: boolean;
  readonly onApplied?: () => void;
}> = ({ tracks, disabled = false, onApplied }) => {
  const [plan, setPlan] = useState<DestinationFixPlanView | null>(null);
  const [applied, setApplied] = useState<DestinationFixApplyView | null>(null);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  // Actions currently waiting on a render job, and which of those jobs have
  // reached a terminal state — once every followed job has, a confirm call
  // runs automatically to chain delivery (and a bundle update, and a health
  // check) through to a final result.
  const [following, setFollowing] = useState<
    readonly { readonly actionId: string; readonly jobId: string; readonly title: string }[]
  >([]);
  const [settledJobIds, setSettledJobIds] = useState<ReadonlySet<string>>(new Set());
  const pendingIdsRef = useRef<readonly string[]>([]);
  const confirmingRef = useRef(false);

  const createPlan = async () => {
    setBusy(true);
    setError(null);
    setApplied(null);
    setFollowing([]);
    setSettledJobIds(new Set());

    try {
      const result = await planDestinationFix(tracks);
      setPlan(result);
      setSelected(new Set(result.actions.filter((a) => a.executable).map((a) => a.id)));
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const apply = async () => {
    setBusy(true);
    setError(null);
    const ids = [...selected];
    pendingIdsRef.current = ids;

    try {
      // Fast, non-waiting call: redeliver/bundle actions complete here as
      // they always have; a rerender_and_deliver action queues its render
      // and comes back with a jobId to follow, never a false success.
      const result = await applyDestinationFix(tracks, ids, { waitForCompletion: false });
      setPlan(result.plan);
      setApplied(result);

      const actionTitleById = new Map(result.plan.actions.map((a) => [a.id, a.title]));
      const queuedJobs = result.results
        .filter((r): r is RemediationActionResult & { jobId: string } => r.status === "queued" && r.jobId !== null)
        .map((r) => ({ actionId: r.actionId, jobId: r.jobId, title: actionTitleById.get(r.actionId) ?? r.kind }));

      if (queuedJobs.length === 0) {
        setSelected(new Set());
        onApplied?.();
        return;
      }

      setSettledJobIds(new Set());
      setFollowing(queuedJobs);
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError(null);

    try {
      const result = await applyDestinationFix(tracks, pendingIdsRef.current, {
        waitForCompletion: true,
        timeoutMs: 30000,
        followJobs: following.map(({ actionId, jobId }) => ({ actionId, jobId })),
      });
      setPlan(result.plan);
      setApplied(result);
      setSelected(new Set());
      onApplied?.();
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setFollowing([]);
      setBusy(false);
    }
  };

  // Fires the confirm call exactly once, right after every followed job has
  // settled. `following` is cleared by `confirm` itself once it finishes.
  useEffect(() => {
    if (following.length === 0 || confirmingRef.current) return;
    if (!following.every((job) => settledJobIds.has(job.jobId))) return;

    confirmingRef.current = true;
    void confirm().finally(() => {
      confirmingRef.current = false;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- confirm reads pendingIdsRef, not a reactive dep
  }, [following, settledJobIds]);

  const safe = plan?.actions.filter((a) => a.safety === "safe") ?? [];
  const manual = plan?.actions.filter((a) => a.safety === "manual") ?? [];

  return (
    <div className="fixplan">
      {error ? <ErrorBanner error={error} title="Could not plan remediation" /> : null}

      <div className="form__actions">
        <button
          className="button button--quiet"
          type="button"
          disabled={disabled || busy || following.length > 0 || tracks?.length === 0}
          title="Proposes safe, reviewed remediation for current destination drift. Nothing is changed until you select actions and apply them."
          onClick={() => void createPlan()}
        >
          {busy && plan === null ? "Planning…" : "Create fix plan"}
        </button>

        {plan ? (
          <span className="muted">
            {plan.summary.findings} finding{plan.summary.findings === 1 ? "" : "s"} ·{" "}
            {plan.summary.safeActions} safe · {plan.summary.manualActions} manual
          </span>
        ) : null}
      </div>

      {plan && plan.summary.blocked ? (
        <p className="note note--error">
          The destination cannot currently be trusted, so nothing here proposes running anything. Restore
          access, then create the plan again.
        </p>
      ) : null}

      {plan && plan.actions.length === 0 && !plan.summary.blocked ? (
        <p className="exportmissing__done">Nothing to fix.</p>
      ) : null}

      {safe.length > 0 ? (
        <>
          <p className="health__group">SAFE — DRY RUN, nothing changes until Apply</p>
          <ul className="fixplan__actions">
            {safe.map((action) => (
              <ActionRow
                key={action.id}
                action={action}
                selectable
                selected={selected.has(action.id)}
                onToggle={() => toggle(action.id)}
                busy={busy || following.length > 0}
              />
            ))}
          </ul>
          <div className="form__actions">
            <button
              className="button"
              type="button"
              disabled={busy || following.length > 0 || selected.size === 0}
              onClick={() => void apply()}
            >
              {busy ? "Applying…" : `Apply ${selected.size} safe action${selected.size === 1 ? "" : "s"}`}
            </button>
          </div>
        </>
      ) : null}

      {manual.length > 0 ? (
        <>
          <p className="health__group">MANUAL — never run automatically</p>
          <ul className="fixplan__actions">
            {manual.map((action) => (
              <ActionRow key={action.id} action={action} selectable={false} busy={busy} />
            ))}
          </ul>
        </>
      ) : null}

      {following.length > 0 ? (
        <>
          <p className="health__group">In progress</p>
          <ul className="fixplan__actions">
            {following.map((job) => (
              <FollowedRender
                key={job.jobId}
                title={job.title}
                jobId={job.jobId}
                onSettled={() =>
                  setSettledJobIds((prev) => {
                    const next = new Set(prev);
                    next.add(job.jobId);
                    return next;
                  })
                }
              />
            ))}
          </ul>
        </>
      ) : null}

      {applied ? (
        <>
          <p className="health__group">Results</p>
          <ul className="health__findings">
            {applied.results.map((result) => (
              <ResultRow key={result.actionId} result={result} />
            ))}
          </ul>
          <p className="muted">Re-scan the destination to confirm the current state.</p>
        </>
      ) : null}
    </div>
  );
};
