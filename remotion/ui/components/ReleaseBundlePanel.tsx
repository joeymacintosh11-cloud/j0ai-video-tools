import { useState } from "react";
import type {
  ReleaseBundlesView,
  ReleaseBundleStatusView,
} from "../../core/domain/api/views.ts";
import type { ReleaseBundleFreshness } from "../../core/domain/delivery/releaseBundle.ts";
import { ApiRequestError, generateReleaseBundles } from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

const LABELS: Record<ReleaseBundleFreshness, string> = {
  current: "Current",
  outdated: "Outdated",
  missing: "Not written yet",
  not_configured: "No destination",
};

/** The one-line answer to "does this folder describe itself correctly?". */
export const ReleaseBundleBadge: React.FC<{
  readonly status: ReleaseBundleStatusView;
}> = ({ status }) => (
  <span
    className={`bundlebadge bundlebadge--${status.freshness}`}
    title={
      status.problem ??
      (status.relativePath
        ? `${LABELS[status.freshness]} — ${status.relativePath}`
        : LABELS[status.freshness])
    }
  >
    {LABELS[status.freshness]}
  </span>
);

/**
 * Writes a track's release bundle, or the catalogue's.
 *
 * `tracks` of null means the catalogue. A dry run first, so the summary shown
 * is the server's own plan rather than a guess assembled here, and only the
 * confirm writes anything — the same two-step shape the delivery and export
 * actions use.
 */
export const ReleaseBundlePanel: React.FC<{
  readonly label: string;
  /** Tracks to cover; null means every track. */
  readonly tracks: readonly string[] | null;
  readonly disabled?: boolean;
  readonly onChanged: () => void;
}> = ({ label, tracks, disabled = false, onChanged }) => {
  const [plan, setPlan] = useState<ReleaseBundlesView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);

    try {
      const result = await generateReleaseBundles(tracks, { dryRun });

      setPlan(result);
      if (!dryRun) onChanged();
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const plural = (count: number, noun: string) =>
    `${count} ${noun}${count === 1 ? "" : "s"}`;

  const pending = plan ? plan.missing.length + plan.outdated.length : 0;
  const failures = plan?.generated.filter((result) => !result.generated) ?? [];

  const counts = plan
    ? [
        plural(plan.tracks, "track"),
        `${plan.current.length} current`,
        `${plan.outdated.length} outdated`,
        `${plan.missing.length} not written`,
        plan.unavailable.length > 0
          ? `${plan.unavailable.length} without a destination`
          : null,
      ]
        .filter((part) => part !== null)
        .join(" · ")
    : "";

  return (
    <div className="exportmissing">
      {error ? (
        <ErrorBanner error={error} title="Could not plan release bundles" />
      ) : null}

      <div className="form__actions">
        <button
          className="button button--quiet"
          type="button"
          disabled={disabled || busy || tracks?.length === 0}
          title="Write release.json and release.md beside the delivered files"
          onClick={() => void run(true)}
        >
          {busy && plan === null ? "Checking…" : label}
        </button>

        {plan ? (
          <>
            {plan.generated.length > 0 ? null : plan.nothingToDo ? (
              <span className="exportmissing__done">
                {plan.root === null
                  ? "No destination configured yet"
                  : plan.catalogue
                    ? "Every bundle is current"
                    : "The bundle is current"}
              </span>
            ) : (
              <button
                className="button"
                type="button"
                disabled={busy}
                onClick={() => void run(false)}
              >
                {busy ? "Writing…" : `Write ${plural(pending, "bundle")}`}
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

          {plan.generated.length > 0 ? (
            <ul className="exportmissing__list">
              {plan.generated.map((result) => (
                <li key={result.slug}>
                  <span className="exportmissing__slug">{result.slug}</span>
                  <span className="exportmissing__preset">
                    {result.generated
                      ? `${result.delivered} delivered`
                      : "not written"}
                  </span>
                  <span className="exportmissing__path">
                    {result.generated
                      ? result.relativePath
                      : (result.problem ?? "")}
                  </span>
                </li>
              ))}
            </ul>
          ) : pending > 0 ? (
            <ul className="exportmissing__list">
              {[...plan.missing, ...plan.outdated].map((entry) => (
                <li key={entry.slug}>
                  <span className="exportmissing__slug">{entry.slug}</span>
                  <span className="exportmissing__preset">
                    {entry.delivered} delivered · {entry.missing} missing
                  </span>
                  <span className="exportmissing__path">
                    {entry.relativePath}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}

          {/* A bundle is a description, so one failing to write changes
              nothing about what actually shipped. */}
          {failures.length > 0 ? (
            <p className="note note--warning">
              <span className="note__message">
                {plural(failures.length, "bundle")} could not be written. The
                delivered files are unaffected.
              </span>
            </p>
          ) : null}

          {plan.unavailable.length > 0 ? (
            <p className="muted">
              {plural(plan.unavailable.length, "track")} cannot be described:{" "}
              {plan.unavailable
                .map((entry) => `${entry.slug}${entry.problem ? ` (${entry.problem})` : ""}`)
                .join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
