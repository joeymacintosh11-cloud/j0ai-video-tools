import { useState } from "react";
import type {
  DestinationFixApplyView,
  DestinationFixPlanView,
  RemediationAction,
  RemediationActionResult,
} from "../../src/domain/api/views.ts";
import { ApiRequestError, applyDestinationFix, planDestinationFix } from "../api/client.ts";
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
      : result.status === "failed" || result.status === "blocked"
        ? "error"
        : "warning";
  const where = [result.slug, result.presetId].filter((part) => part !== null).join(" / ");
  return (
    <li className={`note note--${tone}`}>
      <span className="note__message">
        [{RESULT_LABEL[result.status]}] {result.kind}
        {where ? ` — ${where}` : ""}
        {result.reason ? `: ${result.reason}` : ""}
      </span>
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

  const createPlan = async () => {
    setBusy(true);
    setError(null);
    setApplied(null);

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

    try {
      const result = await applyDestinationFix(tracks, [...selected]);
      setPlan(result.plan);
      setApplied(result);
      setSelected(new Set());
      onApplied?.();
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const safe = plan?.actions.filter((a) => a.safety === "safe") ?? [];
  const manual = plan?.actions.filter((a) => a.safety === "manual") ?? [];

  return (
    <div className="fixplan">
      {error ? <ErrorBanner error={error} title="Could not plan remediation" /> : null}

      <div className="form__actions">
        <button
          className="button button--quiet"
          type="button"
          disabled={disabled || busy || tracks?.length === 0}
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
                busy={busy}
              />
            ))}
          </ul>
          <div className="form__actions">
            <button
              className="button"
              type="button"
              disabled={busy || selected.size === 0}
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
