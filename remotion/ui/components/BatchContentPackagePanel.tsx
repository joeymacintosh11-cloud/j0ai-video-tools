import { useEffect, useRef, useState } from "react";
import { STALE_REASON_LABELS } from "../../src/domain/video/exportFreshness.ts";
import type {
  BatchContentPackageView,
  ContentPackageActionKind,
  ContentPackageBatchPlanView,
} from "../../src/domain/api/views.ts";
import {
  ApiRequestError,
  applyContentPackageBatch,
  inspectContentPackageBatch,
  planContentPackageBatch,
} from "../api/client.ts";
import { PackageStatusBadge } from "./ContentPackagePanel.tsx";
import { DeliverPanel } from "./DeliverPanel.tsx";
import { ErrorBanner } from "./ErrorBanner.tsx";

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

const ACTION_LABEL: Record<ContentPackageActionKind, string> = {
  render_missing: "Render",
  rerender_stale: "Re-render",
  adopt_existing_render: "Already queued",
  already_ready: "Ready",
  blocked: "Blocked",
};

/**
 * Batch Content Package Generation: select several tracks (the catalogue's
 * existing checkbox selection), inspect their packages together, plan what
 * building them would queue, and apply only that plan.
 *
 * Inspect and plan are both read-only — nothing is queued until "Apply" is
 * pressed, and apply re-plans from current state immediately before queueing
 * rather than trusting the plan shown here (see server/routes/
 * contentPackageBatch.ts). Building reuses the existing render queue exactly
 * like a single track's "Build package" button; delivering hands off to the
 * same DeliverPanel every other delivery action already uses, scoped to this
 * selection.
 */
export const BatchContentPackagePanel: React.FC<{
  readonly tracks: readonly string[];
  readonly hasDestination: boolean;
  readonly onQueued: (batchId: string) => void;
  readonly onChanged: () => void;
  readonly onClose: () => void;
}> = ({ tracks, hasDestination, onQueued, onChanged, onClose }) => {
  const [mode, setMode] = useState<"intent" | "full">("intent");
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<ApiRequestError | null>(null);
  const [inspectView, setInspectView] = useState<BatchContentPackageView | null>(null);

  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<ApiRequestError | null>(null);
  const [plan, setPlan] = useState<ContentPackageBatchPlanView | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<ApiRequestError | null>(null);
  const [applyNote, setApplyNote] = useState<string | null>(null);

  const requestId = useRef(0);
  const scope = JSON.stringify([tracks, mode]);

  useEffect(() => {
    const id = ++requestId.current;
    setPlan(null);
    setPlanError(null);
    setApplyNote(null);
    setApplyError(null);
    setInspectView(null);
    setInspectError(null);

    if (tracks.length === 0) return;

    setInspecting(true);
    void inspectContentPackageBatch(tracks, mode)
      .then((view) => {
        if (requestId.current !== id) return;
        setInspectView(view);
      })
      .catch((cause: unknown) => {
        if (requestId.current === id) setInspectError(asApiError(cause));
      })
      .finally(() => {
        if (requestId.current === id) setInspecting(false);
      });
    // scope already captures [tracks, mode]; this effect intentionally
    // re-runs on every selection or mode change, not on other prop changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  const refreshInspect = () => {
    const id = ++requestId.current;
    setInspecting(true);
    void inspectContentPackageBatch(tracks, mode)
      .then((view) => {
        if (requestId.current !== id) return;
        setInspectView(view);
      })
      .catch((cause: unknown) => {
        if (requestId.current === id) setInspectError(asApiError(cause));
      })
      .finally(() => {
        if (requestId.current === id) setInspecting(false);
      });
  };

  const createPlan = async () => {
    setPlanning(true);
    setPlanError(null);
    setApplyNote(null);
    try {
      const result = await planContentPackageBatch(tracks, mode);
      setPlan(result);
    } catch (cause) {
      setPlanError(asApiError(cause));
    } finally {
      setPlanning(false);
    }
  };

  const apply = async () => {
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyContentPackageBatch(tracks, mode);
      setPlan(null);
      if (result.batchId) {
        onQueued(result.batchId);
      }
      setApplyNote(
        result.nothingToDo
          ? "Nothing to build — everything selected is already ready, in flight, or blocked."
          : `Queued ${result.queued.length} render${result.queued.length === 1 ? "" : "s"}.`,
      );
      onChanged();
      refreshInspect();
    } catch (cause) {
      setApplyError(asApiError(cause));
    } finally {
      setApplying(false);
    }
  };

  if (tracks.length === 0) {
    return null;
  }

  return (
    <section className="batchpackage" aria-label="Batch content package">
      <header className="batchpackage__head">
        <h2 className="batchpackage__title">Content packages for {tracks.length} track{tracks.length === 1 ? "" : "s"}</h2>
        <div className="contentpackage__modes">
          <button
            type="button"
            className={`button button--quiet${mode === "intent" ? " button--active" : ""}`}
            onClick={() => setMode("intent")}
          >
            Intended formats
          </button>
          <button
            type="button"
            className={`button button--quiet${mode === "full" ? " button--active" : ""}`}
            onClick={() => setMode("full")}
          >
            Full package (3)
          </button>
        </div>
        <span className="app__spacer" />
        <button type="button" className="button button--quiet" onClick={onClose}>
          Close
        </button>
      </header>

      {inspectError ? <ErrorBanner error={inspectError} title="Could not inspect packages" /> : null}

      {inspecting && inspectView === null ? (
        <p className="muted">Inspecting…</p>
      ) : inspectView ? (
        <>
          <p className="batchpackage__totals">
            {inspectView.totals.totalPlatformTargets} platform target{inspectView.totals.totalPlatformTargets === 1 ? "" : "s"} ·{" "}
            {inspectView.totals.readyTargets} ready · {inspectView.totals.missingTargets} missing ·{" "}
            {inspectView.totals.staleTargets} stale
            {inspectView.totals.rendering > 0 ? ` · ${inspectView.totals.rendering} rendering` : ""}
          </p>
          <p className="batchpackage__totals muted">
            {inspectView.totals.complete} complete · {inspectView.totals.incomplete} incomplete ·{" "}
            {inspectView.totals.stale} stale · {inspectView.totals.blocked} blocked (per track)
          </p>

          <ul className="batchpackage__list">
            {inspectView.tracks.map((track) => (
              <li key={track.slug} className="batchpackage__row">
                <PackageStatusBadge status={track.packageStatus} />
                <span className="batchpackage__slug">{track.title ?? track.slug}</span>
                <span className="exportmissing__counts">
                  {track.readyCount}/{track.readyCount + track.missingCount + track.staleCount + track.renderingCount + track.blockedCount} ready
                  {track.missingCount > 0 ? ` · ${track.missingCount} missing` : ""}
                  {track.staleCount > 0 ? ` · ${track.staleCount} stale` : ""}
                  {track.renderingCount > 0 ? ` · ${track.renderingCount} rendering` : ""}
                  {track.blockedCount > 0 ? ` · ${track.blockedCount} blocked` : ""}
                </span>
              </li>
            ))}
          </ul>

          {inspectView.invalid.length > 0 ? (
            <ul className="notes">
              {inspectView.invalid.map((entry) => (
                <li key={entry.slug} className="note note--error">
                  <div className="note__code">{entry.slug}</div>
                  <div className="note__message">{entry.reason}</div>
                </li>
              ))}
            </ul>
          ) : null}
          {inspectView.duplicates.length > 0 ? (
            <p className="muted">Ignored repeated selection: {inspectView.duplicates.join(", ")}.</p>
          ) : null}
        </>
      ) : null}

      <div className="form__actions">
        <button
          type="button"
          className="button"
          disabled={planning || inspectView === null}
          onClick={() => void createPlan()}
        >
          {planning ? "Planning…" : "Create plan"}
        </button>

        {plan ? (
          <>
            <button
              type="button"
              className="button"
              disabled={applying || plan.renderable.length === 0}
              onClick={() => void apply()}
            >
              {applying
                ? "Queueing…"
                : plan.renderable.length === 0
                  ? "Nothing to build"
                  : `Apply ${plan.renderable.length} action${plan.renderable.length === 1 ? "" : "s"}`}
            </button>
            <button
              type="button"
              className="button button--quiet"
              disabled={applying}
              onClick={() => setPlan(null)}
            >
              Dismiss plan
            </button>
          </>
        ) : null}
      </div>

      {planError ? <ErrorBanner error={planError} title="Could not plan batch" /> : null}
      {applyError ? <ErrorBanner error={applyError} title="Could not apply batch" /> : null}
      {applyNote ? <p className="batchpackage__note">{applyNote}</p> : null}

      {plan ? (
        <div className="batchpackage__plan">
          <p className="exportmissing__counts">
            {plan.renderable.length} safe action{plan.renderable.length === 1 ? "" : "s"} ·{" "}
            {plan.adopted.length} already in flight · {plan.ready.length} already ready ·{" "}
            {plan.blocked.length} blocked
          </p>
          {plan.renderable.length > 0 ? (
            <ul className="exportmissing__list">
              {plan.renderable.map((action) => (
                <li key={`${action.slug}-${action.platformId}`}>
                  <span className="exportmissing__slug">{action.slug}</span>
                  <span className="exportmissing__preset">{action.label}</span>
                  <span className="exportmissing__path">
                    {ACTION_LABEL[action.kind]}
                    {action.staleReasons.length > 0
                      ? ` — ${action.staleReasons.map((reason) => STALE_REASON_LABELS[reason]).join("; ")}`
                      : ""}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {plan.blocked.length > 0 ? (
            <ul className="notes">
              {plan.blocked.map((action) => (
                <li key={`${action.slug}-${action.platformId}-blocked`} className="note note--error">
                  <div className="note__code">
                    {action.slug} · {action.label}
                  </div>
                  <div className="note__message">{action.reason}</div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {hasDestination ? (
        <DeliverPanel
          label="Deliver ready packages"
          tracks={tracks}
          onChanged={onChanged}
        />
      ) : null}
    </section>
  );
};
