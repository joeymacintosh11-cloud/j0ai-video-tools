import { useEffect, useRef, useState } from "react";
import type {
  PublicationHistoryView,
  PublishDestinationsView,
  PublishJobsView,
  PublishJobView,
  PublishPlanView,
  TrackDetailView,
} from "../../core/domain/api/views.ts";
import { PUBLICATION_VISIBILITIES, type PublicationVisibility } from "../../core/domain/publishing/destinations.ts";
import { PUBLISH_PROBLEM_LABELS } from "../../core/domain/publishing/publishProblems.ts";
import { RENDER_PRESETS, RENDER_PRESET_LIST, type RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import {
  RENDERER_IDS,
  RENDERER_LABELS,
  workflowRendererProblem,
  type RendererId,
} from "../../core/domain/video/renderers.ts";
import {
  ApiRequestError,
  cancelPublishJob,
  createPublishJob,
  executePublishJob,
  getContentPackage,
  getPublicationHistory,
  listPublishDestinations,
  listPublishJobs,
  planPublication,
  recoverPublishJob,
} from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";
import {
  acceptedFormats,
  defaultDestination,
  destinationOptionLabel,
  draftMetadataFor,
  JOB_STATE_LABELS,
  planSummary,
  publishRequestBody,
  type PublishDraft,
} from "./publishModel.ts";

/**
 * Publish one existing export to a destination (V3 foundation).
 *
 * Only the local mock destinations can publish in this milestone; the
 * reserved platforms are listed as "not implemented" and can never be chosen
 * to publish. Every request names the source renderer explicitly, the
 * server's plan is the only judge of whether publishing may go ahead, and a
 * publication only ever shows as done once its receipt exists. Nothing here
 * renders or changes the track, its exports or its content package.
 */

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, { code: "INTERNAL_ERROR", message: cause instanceof Error ? cause.message : String(cause) });

const PUBLISHABLE_RENDERERS = RENDERER_IDS.filter((id) => workflowRendererProblem(id) === null);

const shortTime = (iso: string) => new Date(iso).toLocaleString();

export const PublishPanel: React.FC<{ readonly track: TrackDetailView }> = ({ track }) => {
  const [destinations, setDestinations] = useState<PublishDestinationsView | null>(null);
  const [draft, setDraft] = useState<PublishDraft | null>(null);
  const [plan, setPlan] = useState<PublishPlanView | null>(null);
  const [job, setJob] = useState<PublishJobView | null>(null);
  const [history, setHistory] = useState<PublicationHistoryView | null>(null);
  const [jobs, setJobs] = useState<PublishJobsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const mounted = useRef(true);
  const planSeq = useRef(0);
  // The content package's copy, used to seed metadata when the format changes.
  const packageRef = useRef<Awaited<ReturnType<typeof getContentPackage>> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reloadRecords = () => {
    void getPublicationHistory(track.slug).then((view) => mounted.current && setHistory(view)).catch((cause) => mounted.current && setError(asApiError(cause)));
    void listPublishJobs(track.slug).then((view) => mounted.current && setJobs(view)).catch(() => undefined);
  };

  // A new track starts a fresh draft: its preferred renderer and first intended format.
  useEffect(() => {
    setDraft(null);
    setPlan(null);
    setJob(null);
    setNotice(null);
    setError(null);
    reloadRecords();
    let cancelled = false;
    void (async () => {
      try {
        const [list, pkg] = await Promise.all([
          listPublishDestinations(),
          getContentPackage(track.slug, "full").catch(() => null),
        ]);
        if (cancelled) return;
        const destination = defaultDestination(list.destinations);
        const accepted = acceptedFormats(list.destinations.find((d) => d.id === destination));
        const intended = track.exports.filter((output) => output.intended).map((output) => output.presetId);
        const format = intended.find((id) => accepted.includes(id)) ?? accepted[0] ?? intended[0] ?? "youtube-16x9";
        setDestinations(list);
        setDraft({ destination, format, renderer: track.exportsRenderer, ...draftMetadataFor(pkg, format) });
        packageRef.current = pkg;
      } catch (cause) {
        if (!cancelled) setError(asApiError(cause));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [track.slug]);

  // Ask the server whether this would publish — again whenever the draft or the track's exports change.
  const exportsKey = JSON.stringify(track.exports.map((output) => [output.presetId, output.status]));
  useEffect(() => {
    if (draft === null) return;
    const seq = ++planSeq.current;
    const timer = setTimeout(() => {
      planPublication(publishRequestBody(track.slug, draft))
        .then((result) => {
          if (mounted.current && seq === planSeq.current) {
            setPlan(result);
            setError(null);
          }
        })
        .catch((cause) => {
          if (mounted.current && seq === planSeq.current) {
            setPlan(null);
            setError(asApiError(cause));
          }
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [draft, track.slug, exportsKey]);

  if (destinations === null || draft === null) {
    return error ? <ErrorBanner error={error} title="Publishing unavailable" /> : <p className="muted">Loading destinations…</p>;
  }

  const update = (changes: Partial<PublishDraft>) => {
    setNotice(null);
    setDraft((current) => (current === null ? current : { ...current, ...changes }));
  };
  const chooseFormat = (format: RenderPresetId) =>
    update({ format, ...draftMetadataFor(packageRef.current, format) });

  const publish = async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const created = await createPublishJob(publishRequestBody(track.slug, draft));
      setJob(created);
      const settled = created.state === "ready" ? await executePublishJob(created.jobId) : created;
      if (mounted.current) setJob(settled);
    } catch (cause) {
      if (mounted.current) setError(asApiError(cause));
    } finally {
      if (mounted.current) {
        setBusy(false);
        reloadRecords();
      }
    }
  };

  const cancel = async () => {
    if (job === null) return;
    try {
      setJob(await cancelPublishJob(job.jobId));
    } catch (cause) {
      setError(asApiError(cause));
    }
  };

  const recover = async (jobId: string) => {
    try {
      const result = await recoverPublishJob(jobId);
      setNotice(result.recovery);
      if (job?.jobId === jobId) setJob(result);
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      reloadRecords();
    }
  };

  const selected = destinations.destinations.find((d) => d.id === draft.destination);
  const accepted = acceptedFormats(selected);
  const uncertainJobs = jobs?.jobs.filter((entry) => entry.state === "recovery_required") ?? [];

  return (
    <div className="publish" data-testid="publish-panel">
      <p className="note note--info" role="note">
        <span className="note__message">
          Publishing sends one existing, current export to a destination and records a receipt. Only local mock
          destinations can publish in this version — nothing leaves this machine.
        </span>
      </p>

      {destinations.settingsProblem ? (
        <p className="note note--warning" role="status"><span className="note__message">{destinations.settingsProblem}</span></p>
      ) : null}
      {error ? <ErrorBanner error={error} title="Publishing problem" /> : null}

      <div className="form__grid">
        <label className="field">
          <span className="field__label">Destination</span>
          <select
            className="field__input"
            aria-label="Destination"
            value={draft.destination}
            onChange={(event) => update({ destination: event.target.value })}
          >
            {destinations.destinations.map((destination) => (
              <option key={destination.id} value={destination.id}>
                {destinationOptionLabel(destination)}
              </option>
            ))}
          </select>
          <span className="field__hint">
            {selected?.state === "ready"
              ? `${selected.capabilities?.network ? "Network" : "No network"} · account ${selected.accountId ?? "—"} · accepts ${accepted.map((id) => RENDER_PRESETS[id].shortLabel).join(", ")}`
              : selected?.problem}
          </span>
        </label>

        <label className="field">
          <span className="field__label">Format</span>
          <select className="field__input" aria-label="Format" value={draft.format} onChange={(event) => chooseFormat(event.target.value as RenderPresetId)}>
            {RENDER_PRESET_LIST.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.shortLabel}
                {selected?.capabilities && !accepted.includes(preset.id) ? " — not accepted here" : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">Source renderer</span>
          <select className="field__input" aria-label="Source renderer" value={draft.renderer} onChange={(event) => update({ renderer: event.target.value as RendererId })}>
            {PUBLISHABLE_RENDERERS.map((id) => (
              <option key={id} value={id}>
                {RENDERER_LABELS[id]}
                {id === track.exportsRenderer ? " (track preference)" : ""}
              </option>
            ))}
          </select>
          <span className="field__hint">Publishes this renderer's export only — never another renderer's.</span>
        </label>

        <label className="field">
          <span className="field__label">Visibility</span>
          <select className="field__input" aria-label="Visibility" value={draft.visibility} onChange={(event) => update({ visibility: event.target.value as PublicationVisibility })}>
            {PUBLICATION_VISIBILITIES.map((visibility) => (
              <option key={visibility} value={visibility}>{visibility}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="form__grid">
        <label className="field">
          <span className="field__label">Title</span>
          <input className="field__input" aria-label="Publication title" value={draft.title} onChange={(event) => update({ title: event.target.value })} />
        </label>
        <label className="field">
          <span className="field__label">Tags</span>
          <input className="field__input" aria-label="Publication tags" value={draft.tags} onChange={(event) => update({ tags: event.target.value })} />
          <span className="field__hint">Comma separated; a leading # is optional.</span>
        </label>
      </div>
      <label className="field">
        <span className="field__label">Description / caption</span>
        <textarea className="field__input" aria-label="Publication description" rows={3} value={draft.description} onChange={(event) => update({ description: event.target.value })} />
      </label>

      <div className="publish__plan" data-testid="publish-validation" aria-live="polite">
        {plan === null ? (
          <p className="muted">Checking…</p>
        ) : (
          <>
            <p className="exports__intent">
              <span className="exports__intentlabel">Source</span>
              <span data-testid="publish-source">
                {plan.sourceStatus.outputLabel} · {RENDERER_LABELS[plan.sourceRef.renderer]} · {plan.sourceStatus.freshness}
                {plan.source ? ` · rendered ${shortTime(plan.source.renderedAt)} · fingerprint ${plan.source.inputFingerprint.slice(0, 12)}` : ""}
              </span>
            </p>
            <p className={plan.ok ? "note note--info" : "note note--warning"} role="status">
              <span className="note__message" data-testid="publish-validation-summary">
                {plan.ok ? `✓ ${planSummary(plan)} as ${plan.mode ?? "—"}` : `Blocked: ${planSummary(plan)}`}
              </span>
            </p>
            {plan.problems.length > 0 ? (
              <ul className="notes">
                {plan.problems.map((problem, index) => (
                  <li key={index} className="note note--error">
                    <span className="note__code">{PUBLISH_PROBLEM_LABELS[problem.reason]}{problem.field ? ` · ${problem.field}` : ""}</span>
                    <div className="note__message">{problem.message}</div>
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
      </div>

      <div className="form__actions">
        <button className="button" type="button" disabled={busy || plan === null || !plan.ok} onClick={() => void publish()}>
          {busy ? "Publishing…" : "Publish"}
        </button>
        {busy && job !== null && selected?.capabilities?.cancel ? (
          <button className="button button--quiet" type="button" onClick={() => void cancel()}>Cancel</button>
        ) : null}
        {job !== null ? (
          <span className="muted" data-testid="publish-status">
            {JOB_STATE_LABELS[job.state]}
            {job.state !== "published" && job.problems[0] ? ` — ${job.problems[0].message}` : ""}
          </span>
        ) : null}
      </div>
      {notice ? <p className="note note--info" role="status"><span className="note__message">{notice}</span></p> : null}

      {uncertainJobs.length > 0 ? (
        <ul className="notes">
          {uncertainJobs.map((entry) => (
            <li key={entry.jobId} className="note note--warning">
              <div className="note__message">
                {entry.jobId}: {entry.problems[0]?.message ?? "Outcome uncertain."}{" "}
                <button className="button button--quiet" type="button" onClick={() => void recover(entry.jobId)}>Reconcile</button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}

      <h4 className="section__subtitle">Publication history</h4>
      <div data-testid="publish-history">
        {history === null ? (
          <p className="muted">Loading…</p>
        ) : history.receipts.length === 0 ? (
          <p className="muted">Nothing published for this track yet.</p>
        ) : (
          <table className="publish__history">
            <thead>
              <tr><th>Published</th><th>Destination</th><th>Source</th><th>Title</th><th>Publication</th></tr>
            </thead>
            <tbody>
              {history.receipts.map((receipt) => (
                <tr key={receipt.receiptId}>
                  <td>{shortTime(receipt.publishedAt)}</td>
                  <td>{receipt.destination.id}{receipt.destination.accountId ? ` · ${receipt.destination.accountId}` : ""}</td>
                  <td>{RENDER_PRESETS[receipt.source.presetId].shortLabel} · {RENDERER_LABELS[receipt.source.renderer]} · {receipt.source.inputFingerprint.slice(0, 8)}</td>
                  <td>{receipt.metadata.title}</td>
                  <td title={receipt.url ?? ""}>{receipt.publicationId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {history !== null && history.problems.length > 0 ? (
          <p className="note note--warning" role="status"><span className="note__message">The receipt log has {history.problems.length} unreadable line(s); everything readable is shown.</span></p>
        ) : null}
      </div>
    </div>
  );
};
