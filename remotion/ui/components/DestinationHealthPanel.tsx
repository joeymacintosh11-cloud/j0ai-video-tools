import { useState } from "react";
import type {
  DestinationFinding,
  DestinationHealthStatus,
  DestinationHealthView,
} from "../../src/domain/api/views.ts";
import { formatBundleTimestamp } from "../../src/domain/delivery/releaseBundle.ts";
import { ApiRequestError, scanDestinationHealth } from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

const STATUS_LABELS: Record<DestinationHealthStatus, string> = {
  not_configured: "No destination",
  healthy: "Healthy",
  drift: "Drift found",
  unavailable: "Unavailable",
  error: "Scan failed",
};

/** The one-line answer to "does the destination still hold what it should?". */
export const DestinationHealthBadge: React.FC<{
  readonly status: DestinationHealthStatus;
  readonly title?: string;
}> = ({ status, title }) => (
  <span className={`healthbadge healthbadge--${status}`} title={title ?? STATUS_LABELS[status]}>
    {STATUS_LABELS[status]}
  </span>
);

const FindingRow: React.FC<{ readonly finding: DestinationFinding }> = ({ finding }) => (
  <li className={`note note--${finding.severity}`}>
    <span className="note__message">
      {finding.message}
      {finding.relativePath ? (
        <>
          {" — "}
          <code>{finding.relativePath}</code>
        </>
      ) : null}
    </span>
  </li>
);

/**
 * Scans the destination for drift against current delivery records.
 *
 * `tracks` of null scans the whole catalogue and also sweeps the root for
 * orphaned folders; a named list scans only those tracks. One step, not two —
 * unlike delivery and release bundles, there is nothing here to confirm: a
 * scan never writes or deletes anything, so running it *is* the whole action.
 */
export const DestinationHealthPanel: React.FC<{
  readonly label?: string;
  readonly tracks: readonly string[] | null;
  readonly disabled?: boolean;
  readonly onScanned?: (result: DestinationHealthView) => void;
}> = ({ label, tracks, disabled = false, onScanned }) => {
  const [result, setResult] = useState<DestinationHealthView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const scan = async () => {
    setBusy(true);
    setError(null);

    try {
      const scanned = await scanDestinationHealth(tracks);
      setResult(scanned);
      onScanned?.(scanned);
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const findingsFor = result?.tracks.filter((track) => track.findings.length > 0) ?? [];

  return (
    <div className="exportmissing">
      {error ? <ErrorBanner error={error} title="Could not scan the destination" /> : null}

      <div className="form__actions">
        <button
          className="button button--quiet"
          type="button"
          disabled={disabled || busy || tracks?.length === 0}
          title="Compare the destination's actual contents against current delivery records. Nothing is written or deleted."
          onClick={() => void scan()}
        >
          {busy ? "Scanning…" : (label ?? "Scan destination")}
        </button>

        {result ? (
          <>
            <DestinationHealthBadge status={result.status} />
            <span className="muted">
              Scanned {formatBundleTimestamp(result.scannedAt)}
            </span>
            <button
              className="button button--quiet"
              type="button"
              disabled={busy}
              onClick={() => setResult(null)}
            >
              Dismiss
            </button>
          </>
        ) : null}
      </div>

      {result && result.root === null ? (
        <p className="muted">
          {result.rootProblem ?? "No export destination is configured."}
        </p>
      ) : null}

      {result && result.root !== null ? (
        <div className="exportmissing__plan">
          <p className="exportmissing__counts">
            {`${result.counts.tracksChecked} track${result.counts.tracksChecked === 1 ? "" : "s"} checked`}
            {" · "}
            {`${result.counts.healthyTracks} healthy`}
            {" · "}
            {`${result.counts.tracksWithFindings} with findings`}
            {result.counts.totalFindings > 0
              ? ` · ${result.counts.findingsBySeverity.error} error, ` +
                `${result.counts.findingsBySeverity.warning} warning, ` +
                `${result.counts.findingsBySeverity.info} info`
              : ""}
          </p>

          {result.counts.totalFindings === 0 ? (
            <p className="exportmissing__done">
              Everything the destination should hold is there and matches.
            </p>
          ) : (
            <>
              {result.rootFindings.length > 0 ? (
                <>
                  <p className="health__group">Destination</p>
                  <ul className="health__findings">
                    {result.rootFindings.map((finding, index) => (
                      <FindingRow key={`${finding.code}-${index}`} finding={finding} />
                    ))}
                  </ul>
                </>
              ) : null}

              {findingsFor.map((track) => (
                <div key={track.slug}>
                  <p className="health__group">{track.slug}</p>
                  <ul className="health__findings">
                    {track.findings.map((finding, index) => (
                      <FindingRow key={`${finding.code}-${index}`} finding={finding} />
                    ))}
                  </ul>
                </div>
              ))}
            </>
          )}

          {result.invalid.length > 0 ? (
            <p className="muted">
              Could not be scanned:{" "}
              {result.invalid.map((entry) => `${entry.slug} (${entry.reason})`).join(", ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
};
