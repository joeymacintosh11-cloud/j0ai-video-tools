import { useEffect, useRef, useState } from "react";
import type { DeliverView } from "../../core/domain/api/views.ts";
import type { RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import { ApiRequestError, deliverExports } from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

/**
 * "Deliver current exports", in two steps.
 *
 * The first click asks the server what it would copy, so the summary shown is
 * the server's own plan rather than a guess assembled here; only the confirm
 * copies anything. Serves a single track and the whole catalogue — `tracks` of
 * null means the catalogue — so there is one place that describes a delivery.
 */
type DeliverPanelProps = {
  readonly label: string;
  /** Tracks to cover; null means every track. */
  readonly tracks: readonly string[] | null;
  /** Formats to cover; null/omitted uses each track's declared intent. */
  readonly presets?: readonly RenderPresetId[] | null;
  readonly disabled?: boolean;
  readonly onChanged: () => void;
};

// A plan belongs to exactly one scope. Changing tracks or presets discards
// both the plan and any pending response before a confirmation can target a
// different scope.
export const DeliverPanel: React.FC<DeliverPanelProps> = (props) => (
  <ScopedDeliverPanel
    key={JSON.stringify([props.tracks, props.presets ?? null])}
    {...props}
  />
);

const ScopedDeliverPanel: React.FC<DeliverPanelProps> = ({
  label,
  tracks,
  presets = null,
  disabled = false,
  onChanged,
}) => {
  const [plan, setPlan] = useState<DeliverView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);

    try {
      const result = await deliverExports(tracks, presets, dryRun);

      if (!mounted.current) return;
      setPlan(result);
      if (!dryRun) onChanged();
    } catch (cause) {
      if (mounted.current) setError(asApiError(cause));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const plural = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;

  const counts = plan
    ? [
        plural(plan.tracks, "track"),
        `${plan.alreadyDelivered.length} already delivered`,
        `${plan.deliverable.length} to deliver`,
        plan.notCurrent.length > 0
          ? `${plan.notCurrent.length} need${plan.notCurrent.length === 1 ? "s" : ""} a render first`
          : null,
        plan.invalid.length > 0
          ? plural(plan.invalid.length, "invalid track")
          : null,
      ]
        .filter((part) => part !== null)
        .join(" · ")
    : "";

  const failures = plan?.delivered.filter(
    (outcome) => outcome.status !== "delivered",
  );

  return (
    <div className="exportmissing">
      {error ? (
        <ErrorBanner error={error} title="Could not plan delivery" />
      ) : null}

      <div className="form__actions">
        <button
          className="button"
          type="button"
          disabled={disabled || busy || tracks?.length === 0}
          title="Copy current exports to the configured destination"
          onClick={() => void run(true)}
        >
          {busy && plan === null ? "Checking…" : label}
        </button>

        {plan ? (
          <>
            {plan.delivered.length > 0 ? null : plan.nothingToDo ? (
              <span className="exportmissing__done">
                {plan.rootProblem === null
                  ? plan.root === null
                    ? "No destination configured yet"
                    : plan.catalogue
                      ? "Everything current is already delivered"
                      : "Already delivered"
                  : plan.rootProblem}
              </span>
            ) : (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void run(false)}
              >
                {busy
                  ? "Copying…"
                  : `Deliver ${plural(plan.deliverable.length, "export")}`}
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

          {plan.delivered.length > 0 ? (
            <ul className="exportmissing__list">
              {plan.delivered.map((outcome) => (
                <li key={`${outcome.slug}-${outcome.presetId}`}>
                  <span className="exportmissing__slug">{outcome.slug}</span>
                  <span className="exportmissing__preset">{outcome.label}</span>
                  <span className="exportmissing__path">
                    {outcome.status === "delivered"
                      ? /* A copy that landed but was not recorded is still a
                           copy that landed, so it says both. */
                        (outcome.historyProblem === null
                          ? outcome.destinationRelativePath
                          : `${outcome.destinationRelativePath} — not recorded in the delivery log`)
                      : (outcome.message ?? outcome.status)}
                  </span>
                </li>
              ))}
            </ul>
          ) : plan.deliverable.length > 0 ? (
            <ul className="exportmissing__list">
              {plan.deliverable.map((target) => (
                <li key={`${target.slug}-${target.presetId}`}>
                  <span className="exportmissing__slug">{target.slug}</span>
                  <span className="exportmissing__preset">{target.label}</span>
                  <span className="exportmissing__path">
                    {target.destinationRelativePath}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {/* A delivery failing never touches the rendered export, and saying
              so here is the difference between "lost work" and "try again". */}
          {failures && failures.length > 0 ? (
            <p className="note note--warning">
              <span className="note__message">
                {plural(failures.length, "delivery")} failed. The rendered
                exports in out/ are unaffected — you can deliver again.
              </span>
            </p>
          ) : null}

          {plan.notCurrent.length > 0 ? (
            <p className="muted">
              {plural(plan.notCurrent.length, "export")} cannot be delivered
              until re-rendered:{" "}
              {plan.notCurrent
                .map(
                  (target) =>
                    `${target.slug} ${target.label} (${target.freshness})`,
                )
                .join(", ")}
            </p>
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
