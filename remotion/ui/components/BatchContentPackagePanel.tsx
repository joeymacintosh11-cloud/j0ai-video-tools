import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { replaceBatchTrackPackage } from "../../src/domain/content/contentPackageBatch.ts";
import { STALE_REASON_LABELS } from "../../src/domain/video/exportFreshness.ts";
import type {
  BatchContentPackageView,
  ContentPackageBatchApplyView,
  ContentPackageActionKind,
  ContentPackageBatchPlanView,
  RenderJobView,
} from "../../src/domain/api/views.ts";
import {
  PLATFORM_LIST,
  type PlatformId,
} from "../../src/domain/content/platformProfiles.ts";
import {
  ApiRequestError,
  applyContentPackageBatch,
  getContentPackage,
  getRender,
  inspectContentPackageBatch,
  planContentPackageBatch,
} from "../api/client.ts";
import {
  classifyRecoveredJob,
  type BatchSessionJobReference,
  type BatchSessionMode,
} from "../batchSession.ts";
import { useRenderJob } from "../hooks/useRenderJob.ts";
import { deriveLiveBatchProgress } from "./batchProgressModel.ts";
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

/** One existing per-job SSE follower per unique job ID, including adopted jobs. */
const JobFollower: React.FC<{
  readonly jobId: string;
  readonly onSnapshot: (jobId: string, job: RenderJobView | null, missing: boolean) => void;
  readonly onTerminal: (jobId: string) => void;
}> = ({ jobId, onSnapshot, onTerminal }) => {
  const { job, missing } = useRenderJob(jobId, () => onTerminal(jobId), false);
  useEffect(() => { onSnapshot(jobId, job, missing); }, [jobId, job, missing, onSnapshot]);
  return null;
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
  readonly mode: BatchSessionMode;
  readonly platforms: readonly PlatformId[];
  readonly jobReferences: readonly BatchSessionJobReference[];
  readonly initialJobs: readonly RenderJobView[];
  readonly onModeChange: (mode: BatchSessionMode) => void;
  readonly onPlatformsChange: (platforms: readonly PlatformId[]) => void;
  readonly onApplied: (view: ContentPackageBatchApplyView) => void;
  readonly onJobIdsPruned: (jobIds: ReadonlySet<string>) => void;
  readonly onChanged: () => void;
  readonly onClose: () => void;
}> = ({
  tracks, hasDestination, onQueued, mode, platforms, jobReferences, initialJobs,
  onModeChange, onPlatformsChange, onApplied, onJobIdsPruned, onChanged, onClose,
}) => {
  const [inspecting, setInspecting] = useState(false);
  const [inspectError, setInspectError] = useState<ApiRequestError | null>(null);
  const [inspectView, setInspectView] = useState<BatchContentPackageView | null>(null);

  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<ApiRequestError | null>(null);
  const [plan, setPlan] = useState<ContentPackageBatchPlanView | null>(null);

  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<ApiRequestError | null>(null);
  const [applyNote, setApplyNote] = useState<string | null>(null);
  const [jobs, setJobs] = useState<Readonly<Record<string, RenderJobView>>>(() =>
    Object.fromEntries(initialJobs.map((job) => [job.id, job])));
  const [terminalReferences, setTerminalReferences] = useState<readonly BatchSessionJobReference[]>([]);
  const [missingJobs, setMissingJobs] = useState<ReadonlySet<string>>(new Set());
  const [restoringJobs, setRestoringJobs] = useState(jobReferences.length > 0);
  const [recoveryErrors, setRecoveryErrors] = useState<Readonly<Record<string, string>>>({});
  const [refreshingSlugs, setRefreshingSlugs] = useState<ReadonlySet<string>>(new Set());
  const [refreshErrors, setRefreshErrors] = useState<Readonly<Record<string, string>>>({});

  const requestId = useRef(0);
  const requestMode: "intent" | "full" = mode === "full" ? "full" : "intent";
  const requestPlatforms = mode === "platforms" ? platforms : undefined;
  const scope = JSON.stringify([tracks, requestMode, requestPlatforms]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const tracksRef = useRef(tracks);
  tracksRef.current = tracks;
  const modeRef = useRef(requestMode);
  modeRef.current = requestMode;
  const platformsRef = useRef(requestPlatforms);
  platformsRef.current = requestPlatforms;
  const jobReferencesRef = useRef(jobReferences);
  jobReferencesRef.current = jobReferences;
  const jobsRef = useRef(jobs);
  jobsRef.current = jobs;
  const refreshQueue = useRef(new Set<string>());
  const refreshJobIds = useRef(new Map<string, Set<string>>());
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshVersion = useRef(new Map<string, number>());
  const notified = useRef(new Set<string>());
  const recovered = useRef(new Set(initialJobs
    .filter((job) => ["queued", "preparing", "rendering"].includes(job.status))
    .map((job) => job.id)));
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    };
  }, []);

  const onSnapshot = useCallback((jobId: string, job: RenderJobView | null, missing: boolean) => {
    if (job) {
      jobsRef.current = { ...jobsRef.current, [jobId]: job };
      setJobs((previous) => previous[jobId] === job ? previous : { ...previous, [jobId]: job });
    }
    if (missing) setMissingJobs((previous) => previous.has(jobId) ? previous : new Set([...previous, jobId]));
  }, []);

  const onTerminal = useCallback((jobId: string) => {
    if (notified.current.has(jobId)) return;
    notified.current.add(jobId);
    const slugs = new Set(jobReferencesRef.current
      .filter((ref) => ref.jobId === jobId && tracksRef.current.includes(ref.slug))
      .map((ref) => ref.slug));
    if (slugs.size === 0) return;
    // Any older whole-batch response can no longer overwrite a terminal
    // refresh. The following requests touch only the affected tracks.
    requestId.current++;
    setInspecting(false);
    for (const slug of slugs) {
      refreshQueue.current.add(slug);
      const ids = refreshJobIds.current.get(slug) ?? new Set<string>();
      ids.add(jobId);
      refreshJobIds.current.set(slug, ids);
    }
    setRefreshingSlugs((previous) => new Set([...previous, ...slugs]));
    if (refreshTimer.current !== null) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      const pending = [...refreshQueue.current];
      refreshQueue.current.clear();
      const scopeAtStart = scopeRef.current;
      const modeAtStart = modeRef.current;
      const platformsAtStart = platformsRef.current;
      for (const slug of pending) {
        const version = (refreshVersion.current.get(slug) ?? 0) + 1;
        refreshVersion.current.set(slug, version);
        void getContentPackage(slug, modeAtStart, platformsAtStart)
          .then((pkg) => {
            if (!mounted.current || scopeRef.current !== scopeAtStart || refreshVersion.current.get(slug) !== version) return;
            setInspectView((previous) => previous ? replaceBatchTrackPackage(previous, pkg) : previous);
            const terminalIds = refreshJobIds.current.get(slug);
            if (terminalIds) {
              const finalReferences = jobReferencesRef.current.filter((reference) => {
                const job = jobsRef.current[reference.jobId];
                return terminalIds.has(reference.jobId) && job &&
                  ["completed", "failed", "cancelled"].includes(job.status);
              });
              if (finalReferences.length > 0) {
                setTerminalReferences((previous) => {
                  const merged = new Map(previous.map((reference) => [reference.actionId, reference]));
                  for (const reference of finalReferences) merged.set(reference.actionId, reference);
                  return [...merged.values()];
                });
              }
              refreshJobIds.current.delete(slug);
              onJobIdsPruned(terminalIds);
            }
            setRefreshErrors((previous) => {
              if (!(slug in previous)) return previous;
              const next = { ...previous };
              delete next[slug];
              return next;
            });
          })
          .catch((cause: unknown) => {
            if (!mounted.current || scopeRef.current !== scopeAtStart || refreshVersion.current.get(slug) !== version) return;
            setRefreshErrors((previous) => ({ ...previous, [slug]: asApiError(cause).message }));
          })
          .finally(() => {
            if (!mounted.current || scopeRef.current !== scopeAtStart || refreshVersion.current.get(slug) !== version) return;
            setRefreshingSlugs((previous) => {
              const next = new Set(previous);
              next.delete(slug);
              return next;
            });
          });
      }
    }, 50);
  }, [onJobIdsPruned]);

  const uniqueJobIds = useMemo(() => [...new Set(jobReferences
    .map((ref) => ref.jobId))], [jobReferences]);
  const activeJobIds = uniqueJobIds.filter((jobId) => {
    const job = jobs[jobId];
    return job && ["queued", "preparing", "rendering"].includes(job.status);
  });
  const displayedReferences = useMemo(() => {
    const merged = new Map(terminalReferences.map((reference) => [reference.actionId, reference]));
    for (const reference of jobReferences) merged.set(reference.actionId, reference);
    return [...merged.values()];
  }, [jobReferences, terminalReferences]);
  const live = useMemo(() => inspectView
    ? deriveLiveBatchProgress(inspectView, displayedReferences.map((reference) => ({ ...reference, outcome: "adopted" as const })), jobs, refreshingSlugs)
    : null, [displayedReferences, inspectView, jobs, refreshingSlugs]);

  useEffect(() => {
    const id = ++requestId.current;
    refreshQueue.current.clear();
    if (refreshTimer.current !== null) clearTimeout(refreshTimer.current);
    refreshTimer.current = null;
    setRefreshingSlugs(new Set());
    setRefreshErrors({});
    setPlan(null);
    setPlanError(null);
    setApplyNote(null);
    setApplyError(null);
    setPlanning(false);
    setApplying(false);
    setInspectView(null);
    setInspectError(null);

    if (tracks.length === 0) {
      setInspecting(false);
      return;
    }

    setInspecting(true);
    void inspectContentPackageBatch(tracks, requestMode, requestPlatforms)
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

  // A persisted job ID is only a hint. Re-read every exact ID before opening
  // an SSE stream; only server-confirmed queued/running jobs are followed.
  useEffect(() => {
    if (inspectView === null) return;
    const pending = jobReferences.filter((reference) => !recovered.current.has(reference.jobId));
    if (pending.length === 0) {
      setRestoringJobs(false);
      return;
    }
    let cancelled = false;
    setRestoringJobs(true);
    void Promise.all(pending.map(async (reference) => {
      try {
        const job = await getRender(reference.jobId);
        if (cancelled) return;
        const disposition = classifyRecoveredJob(reference, job);
        if (disposition === "mismatch") {
          setMissingJobs((previous) => new Set([...previous, reference.jobId]));
          onTerminal(reference.jobId);
          return;
        }
        jobsRef.current = { ...jobsRef.current, [job.id]: job };
        setJobs((previous) => ({ ...previous, [job.id]: job }));
        setRecoveryErrors((previous) => {
          if (!(job.id in previous)) return previous;
          const next = { ...previous };
          delete next[job.id];
          return next;
        });
        if (disposition === "terminal") onTerminal(job.id);
      } catch (cause) {
        if (cancelled) return;
        const error = asApiError(cause);
        if (error.status === 404) {
          setMissingJobs((previous) => new Set([...previous, reference.jobId]));
          onTerminal(reference.jobId);
        } else {
          setRecoveryErrors((previous) => ({ ...previous, [reference.jobId]: error.message }));
        }
      } finally {
        recovered.current.add(reference.jobId);
      }
    })).finally(() => {
      if (!cancelled) setRestoringJobs(false);
    });
    return () => { cancelled = true; };
  }, [inspectView, jobReferences, onTerminal]);

  const refreshInspect = () => {
    const id = ++requestId.current;
    setInspecting(true);
    setInspectError(null);
    void inspectContentPackageBatch(tracks, requestMode, requestPlatforms)
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
    const requestScope = scope;
    setPlanning(true);
    setPlanError(null);
    setApplyNote(null);
    try {
      const result = await planContentPackageBatch(tracks, requestMode, requestPlatforms);
      if (scopeRef.current === requestScope) setPlan(result);
    } catch (cause) {
      if (scopeRef.current === requestScope) setPlanError(asApiError(cause));
    } finally {
      if (scopeRef.current === requestScope) setPlanning(false);
    }
  };

  const apply = async () => {
    const requestScope = scope;
    setApplying(true);
    setApplyError(null);
    try {
      const result = await applyContentPackageBatch(tracks, requestMode, requestPlatforms);
      if (result.renderBatch) {
        jobsRef.current = {
          ...jobsRef.current,
          ...Object.fromEntries(result.renderBatch.jobs.map((job) => [job.id, job])),
        };
        setJobs((previous) => ({
          ...previous,
          ...Object.fromEntries(result.renderBatch!.jobs.map((job) => [job.id, job])),
        }));
        for (const job of result.renderBatch.jobs) recovered.current.add(job.id);
      }
      onApplied(result);
      if (result.batchId) {
        onQueued(result.batchId);
      }
      if (scopeRef.current === requestScope) {
        setPlan(null);
        setApplyNote(
          result.nothingToDo
            ? "Nothing to build — everything selected is already ready, in flight, or blocked."
            : `Queued ${result.queued.length} render${result.queued.length === 1 ? "" : "s"}.${result.timedOut ? " Stopped waiting; renders continue." : ""}`,
        );
        refreshInspect();
      }
      onChanged();
    } catch (cause) {
      if (scopeRef.current === requestScope) setApplyError(asApiError(cause));
    } finally {
      if (scopeRef.current === requestScope) setApplying(false);
    }
  };

  if (tracks.length === 0) {
    return null;
  }

  const activeKeys = new Set(jobReferences
    .filter((ref) => ref.jobId && jobs[ref.jobId] &&
      ["queued", "preparing", "rendering"].includes(jobs[ref.jobId].status))
    .map((ref) => `${ref.slug}::${ref.presetId}`));
  const allPlannedActionsActive = Boolean(plan && plan.renderable.length > 0 &&
    plan.renderable.every((action) => activeKeys.has(`${action.slug}::${action.presetId}`)));

  return (
    <section className="batchpackage" aria-label="Batch content package">
      {activeJobIds.map((jobId) => (
        <JobFollower key={jobId} jobId={jobId} onSnapshot={onSnapshot} onTerminal={onTerminal} />
      ))}
      <header className="batchpackage__head">
        <h2 className="batchpackage__title">Content packages for {tracks.length} track{tracks.length === 1 ? "" : "s"}</h2>
        <div className="contentpackage__modes">
          <button
            type="button"
            className={`button button--quiet${mode === "intent" ? " button--active" : ""}`}
            onClick={() => onModeChange("intent")}
          >
            Intended formats
          </button>
          <button
            type="button"
            className={`button button--quiet${mode === "full" ? " button--active" : ""}`}
            onClick={() => onModeChange("full")}
          >
            Full package (3)
          </button>
          <button
            type="button"
            className={`button button--quiet${mode === "platforms" ? " button--active" : ""}`}
            onClick={() => {
              if (platforms.length === 0) onPlatformsChange(PLATFORM_LIST.map((platform) => platform.id));
              onModeChange("platforms");
            }}
          >
            Selected platforms
          </button>
        </div>
        <span className="app__spacer" />
        <button type="button" className="button button--quiet" onClick={onClose}>
          Close
        </button>
      </header>

      {mode === "platforms" ? (
        <div className="contentpackage__modes" aria-label="Batch platforms">
          {PLATFORM_LIST.map((platform) => {
            const selected = platforms.includes(platform.id);
            return (
              <button
                key={platform.id}
                type="button"
                className={`button button--quiet${selected ? " button--active" : ""}`}
                disabled={selected && platforms.length === 1}
                onClick={() => onPlatformsChange(selected
                  ? platforms.filter((id) => id !== platform.id)
                  : [...platforms, platform.id])}
              >
                {platform.label}
              </button>
            );
          })}
        </div>
      ) : null}

      {inspectError ? <ErrorBanner error={inspectError} title="Could not inspect packages" /> : null}

      {restoringJobs ? <p className="muted">Reconnecting to renders…</p> : null}
      {Object.entries(recoveryErrors).map(([jobId, message]) => (
        <p key={jobId} className="note note--warning" role="status">Could not reconnect to render {jobId}: {message}</p>
      ))}

      {inspecting && inspectView === null ? (
        <p className="muted">Inspecting…</p>
      ) : inspectView && live ? (
        <>
          <p className="batchpackage__totals">
            {live.totals.total} platform target{live.totals.total === 1 ? "" : "s"} ·{" "}
            {live.totals.ready} ready · {live.totals.missing} missing ·{" "}
            {live.totals.stale} stale
            {live.totals.queued > 0 ? ` · ${live.totals.queued} queued` : ""}
            {live.totals.rendering > 0 ? ` · ${live.totals.rendering} rendering` : ""}
            {live.totals.checking > 0 ? ` · ${live.totals.checking} checking` : ""}
          </p>
          <p className="batchpackage__totals muted">
            {inspectView.totals.complete} complete · {inspectView.totals.incomplete} incomplete ·{" "}
            {inspectView.totals.stale} stale · {inspectView.totals.blocked} blocked (per track)
          </p>

          <ul className="batchpackage__list">
            {live.tracks.map((track) => (
              <li key={track.slug} className="batchpackage__row">
                <PackageStatusBadge status={track.packageStatus} />
                <span className="batchpackage__slug">{track.title ?? track.slug}</span>
                <span className="exportmissing__counts">
                  {track.ready}/{track.total} ready
                  {track.queued > 0 ? ` · ${track.queued} queued` : ""}
                  {track.rendering > 0 ? ` · ${track.rendering} rendering` : ""}
                </span>
                <ul className="batchpackage__platforms">
                  {track.platforms.map(({ platform, state, jobState, progressPercent, error, jobId }) => (
                    <li key={platform.platformId} className="batchpackage__platform">
                      <span>{platform.label}</span>
                      <span className="muted">
                        {jobState === "render_failed" ? "Render failed"
                          : jobState === "cancelled" ? "Cancelled"
                            : state === "checking" ? "Checking package state"
                              : state === "rendering" && jobState === "rendering" ? "Rendering"
                                : state === "queued" ? "Queued"
                                  : state === "ready" ? "Ready"
                                    : state === "stale" ? "Stale"
                                      : state === "missing" ? "Missing" : "Blocked"}
                        {progressPercent !== null ? ` ${progressPercent}%` : ""}
                        {jobState === "completed" && state !== "checking" ? " · Render completed" : ""}
                      </span>
                      {progressPercent !== null ? (
                        <span className="batchpackage__progress progress" aria-label={`${progressPercent}% rendered`}>
                          <span className="progress__fill" style={{ width: `${progressPercent}%` }} />
                        </span>
                      ) : null}
                      {error ? <span className="batchpackage__joberror">{error}</span> : null}
                      {jobId && missingJobs.has(jobId) ? <span className="batchpackage__joberror">Render job no longer known to server; inspect again.</span> : null}
                    </li>
                  ))}
                </ul>
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
      {Object.entries(refreshErrors).map(([slug, message]) => (
        <p key={slug} className="note note--warning" role="status">Could not refresh package state for {slug}: {message}</p>
      ))}

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
              disabled={applying || plan.renderable.length === 0 || allPlannedActionsActive}
              onClick={() => void apply()}
            >
              {applying
                ? "Queueing…"
                : allPlannedActionsActive
                  ? "Already in flight"
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
