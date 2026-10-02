import {
  STALE_REASON_LABELS,
  type ExportMode,
} from "../../core/domain/video/exportFreshness.ts";
import { useEffect, useRef, useState } from "react";
import type { ExportMissingView } from "../../core/domain/api/views.ts";
import type { RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import { ApiRequestError, exportMissing } from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

/**
 * "Export what's missing", in two steps.
 *
 * The first click asks the server what would happen without queueing anything,
 * so the summary shown is the server's own plan rather than a guess assembled
 * in the browser. Only the confirm actually enqueues. When nothing is missing
 * there is nothing to confirm, and it says so instead of offering a button that
 * would do nothing.
 *
 * One panel serves all three scopes: a single track, the ticked tracks, and the
 * whole catalogue. `tracks` of null means the catalogue, and `formats` of null
 * means each track's own declared intent — which is the ordinary case, since
 * different tracks ship in different formats.
 */
export const ExportMissingPanel: React.FC<{
  readonly label: string;
  /** Tracks to cover; null means every track in the catalogue. */
  readonly tracks: readonly string[] | null;
  /** Formats to force; null uses each track's declared intent. */
  readonly formats: readonly RenderPresetId[] | null;
  readonly disabled?: boolean;
  readonly onQueued: (batchId: string) => void;
  readonly onChanged: () => void;
}> = ({ label, tracks, formats, disabled = false, onQueued, onChanged }) => {
  const [plan, setPlan] = useState<ExportMissingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const requestId = useRef(0);
  const scope = JSON.stringify([tracks, formats]);
  useEffect(() => {
    requestId.current++;
    setPlan(null);
    setBusy(false);
    const counter = requestId;
    return () => {
      counter.current++;
    };
  }, [scope]);

  const run = async (dryRun: boolean, mode: ExportMode) => {
    const id = ++requestId.current;
    setBusy(true);
    setError(null);

    try {
      const result = await exportMissing(tracks, formats, dryRun, mode);
      if (requestId.current !== id) return;

      if (dryRun) {
        setPlan(result);
        return;
      }

      setPlan(null);
      if (result.batchId) {
        onQueued(result.batchId);
      }
      onChanged();
    } catch (cause) {
      if (requestId.current === id) setError(asApiError(cause));
    } finally {
      if (requestId.current === id) setBusy(false);
    }
  };

  const plural = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;

  const counts = plan
    ? [
        plural(plan.tracks, "track"),
        plural(plan.intendedTargets.length, "intended export"),
        `${plan.current.length} current`,
        `${plan.stale.length} stale`,
        plan.skippedQueued.length > 0
          ? `${plan.skippedQueued.length} already queued`
          : null,
        plan.skippedActive.length > 0
          ? `${plan.skippedActive.length} rendering now`
          : null,
        `${plan.missing.length} missing`,
        plan.invalid.length > 0
          ? plural(plan.invalid.length, "invalid track")
          : null,
      ]
        .filter((part) => part !== null)
        .join(" · ")
    : "";

  return (
    <div className="exportmissing">
      {error ? (
        <ErrorBanner error={error} title="Could not plan exports" />
      ) : null}

      <div className="form__actions">
        <button
          className="button"
          type="button"
          disabled={disabled || busy || tracks?.length === 0}
          title={
            formats === null
              ? "Queue each track's intended formats that have not been rendered yet"
              : "Queue only the selected formats that have not been rendered yet"
          }
          onClick={() => void run(true, "missing")}
        >
          {busy && plan === null ? "Checking…" : label}
        </button>

        {(["stale", "missing-and-stale"] as const).map((mode) => (
          <button
            key={mode}
            className="button"
            type="button"
            disabled={disabled || busy || tracks?.length === 0}
            onClick={() => void run(true, mode)}
          >
            {mode === "stale" ? "Re-export stale" : "Export missing + stale"}
            {tracks === null ? " for catalogue" : ""}
          </button>
        ))}

        {plan ? (
          <>
            {plan.nothingToDo ? (
              <span className="exportmissing__done">
                {plan.mode === "missing"
                  ? "No missing exports"
                  : "No matching exports to queue"}
              </span>
            ) : (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void run(false, plan.mode)}
              >
                {busy
                  ? "Queueing…"
                  : `Queue ${plan.selected.length} render${plan.selected.length === 1 ? "" : "s"}`}
              </button>
            )}
            <button
              className="button button--quiet"
              type="button"
              disabled={busy}
              onClick={() => setPlan(null)}
            >
              Dismiss
            </button>
          </>
        ) : null}
      </div>

      {plan ? (
        <div className="exportmissing__plan">
          <p className="exportmissing__counts">{counts}</p>
          {plan.selected.some((target) => target.staleReasons?.length) ? (
            <p className="muted">
              Confirming queues replacements for{" "}
              {
                plan.selected.filter((target) => target.staleReasons?.length)
                  .length
              }{" "}
              stale export(s). Existing videos are kept until each replacement
              succeeds.
            </p>
          ) : null}

          {plan.selected.length > 0 ? (
            <ul className="exportmissing__list">
              {plan.selected.map((target) => (
                <li key={`${target.slug}-${target.presetId}`}>
                  <span className="exportmissing__slug">{target.slug}</span>
                  <span className="exportmissing__preset">{target.label}</span>
                  <span className="exportmissing__path">
                    {target.outputLabel}
                    {target.staleReasons?.length
                      ? ` — Replace: ${target.staleReasons.map((reason) => STALE_REASON_LABELS[reason]).join("; ")}`
                      : " — New export"}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {plan.invalid.length > 0 ? (
            <ul className="notes">
              {plan.invalid.map((entry) => (
                <li key={entry.slug} className="note note--error">
                  <div className="note__code">
                    {entry.slug} · {entry.code}
                  </div>
                  <div className="note__message">{entry.reason}</div>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
