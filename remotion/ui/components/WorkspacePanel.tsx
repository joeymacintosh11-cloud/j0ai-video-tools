import { useEffect, useState } from "react";
import type {
  WorkspaceInspection,
  WorkspaceMaintenance,
} from "../../core/ports/rendererWorkspace.ts";
import { inspectWorkspace, maintainWorkspace } from "../api/client.ts";

export const WorkspacePanel: React.FC = () => {
  const [state, setState] = useState<WorkspaceInspection | null>(null);
  const [plan, setPlan] = useState<WorkspaceMaintenance | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void inspectWorkspace()
      .then((result) => {
        if (!cancelled) setState(result);
      })
      .catch((cause) => {
        if (!cancelled) setError(String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const run = async (dryRun: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await maintainWorkspace(
        dryRun,
        true,
        dryRun
          ? undefined
          : plan?.candidates.flatMap((item) => [
              item.path,
              ...(item.relatedPaths ?? []),
            ]),
      );
      // Maintenance returns its pre-operation inspection; observe the result
      // again after applying so removed locks do not remain on screen.
      setState(dryRun ? result.inspection : await inspectWorkspace());
      setPlan(dryRun ? result : null);
      if (result.failures.length)
        setError(
          result.failures.map((e) => `${e.path}: ${e.message}`).join("; "),
        );
    } catch (cause) {
      setError(String(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="workspace">
      <h4>AE workspace</h4>
      {state ? (
        <p>
          {state.problem ??
            (state.manual || state.orphanedLocks
              ? `AE recovery attention: ${state.orphanedLocks} orphaned locks; ${state.manual} manual inspection items.`
              : "AE workspace clean")}{" "}
          Prepared cache: {state.cacheEntries} entries /{" "}
          {(state.cacheBytes / 1048576).toFixed(1)} MB. {state.activeJobs}{" "}
          active jobs; {state.recoverable} safe cleanup items.
        </p>
      ) : (
        <p>Checking workspace…</p>
      )}
      {error ? <p role="alert">{error}</p> : null}
      <button
        className="button"
        disabled={busy || state?.configured !== true}
        onClick={() => void run(true)}
      >
        Preview safe cleanup + cache pruning
      </button>
      {plan ? (
        <div>
          <p>
            Dry run — no files deleted. Only the listed safe artifacts will be
            considered again before removal.
          </p>
          <ul>
            {plan.candidates.map((item) => (
              <li key={item.path}>
                {item.path}
                {item.relatedPaths?.length
                  ? ` + ${item.relatedPaths.join(" + ")}`
                  : ""}{" "}
                — {item.reason}
              </li>
            ))}
          </ul>
          <button
            className="button"
            disabled={busy || plan.candidates.length === 0}
            onClick={() => void run(false)}
          >
            Apply safe cleanup + cache pruning
          </button>
          <button className="button" onClick={() => setPlan(null)}>
            Dismiss cleanup preview
          </button>
        </div>
      ) : null}
      {state?.manual ? (
        <p>
          Uncertain ownership/completion stays untouched. Inspect with npm run
          ae-workspace before manual recovery.
        </p>
      ) : null}
    </div>
  );
};
