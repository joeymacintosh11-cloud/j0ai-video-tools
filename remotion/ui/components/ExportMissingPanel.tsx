import { useState } from "react";
import type { ExportMissingView } from "../../src/domain/api/views.ts";
import type { RenderPresetId } from "../../src/domain/video/renderPresets.ts";
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

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);

    try {
      const result = await exportMissing(tracks, formats, dryRun);

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
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const plural = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;

  const counts = plan
    ? [
        plural(plan.tracks, "track"),
        plural(plan.intendedTargets.length, "intended export"),
        `${plan.skippedExisting.length} already rendered`,
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
      {error ? <ErrorBanner error={error} title="Could not plan exports" /> : null}

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
          onClick={() => void run(true)}
        >
          {busy && plan === null ? "Checking…" : label}
        </button>

        {plan ? (
          <>
            {plan.nothingToDo ? (
              <span className="exportmissing__done">
                {plan.catalogue
                  ? "Catalogue is fully exported"
                  : "All intended exports already exist"}
              </span>
            ) : (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void run(false)}
              >
                {busy
                  ? "Queueing…"
                  : `Queue ${plan.missing.length} render${plan.missing.length === 1 ? "" : "s"}`}
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

          {plan.missing.length > 0 ? (
            <ul className="exportmissing__list">
              {plan.missing.map((target) => (
                <li key={`${target.slug}-${target.presetId}`}>
                  <span className="exportmissing__slug">{target.slug}</span>
                  <span className="exportmissing__preset">{target.label}</span>
                  <span className="exportmissing__path">{target.outputLabel}</span>
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
