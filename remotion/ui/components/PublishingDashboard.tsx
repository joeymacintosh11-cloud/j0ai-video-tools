import { useCallback, useEffect, useState } from "react";
import type { PublicationDraftView, TrackSummaryView } from "../../core/domain/api/views.ts";
import {
  DRAFT_PLATFORM_LABELS,
  DRAFT_PLATFORM_RULES,
  DRAFT_STATUSES,
  DRAFT_STATUS_LABELS,
  type DraftPlatform,
  type DraftStatus,
} from "../../core/domain/publishing/publicationDraft.ts";
import { RENDER_PRESETS } from "../../core/domain/video/renderPresets.ts";
import { RENDERER_LABELS } from "../../core/domain/video/renderers.ts";
import {
  ApiRequestError,
  createPublicationDraft,
  getContentPackage,
  listPublicationDrafts,
  updatePublicationDraft,
} from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";
import {
  draftFields,
  exportedAssets,
  formFromDraft,
  newDraftForm,
  parseHashtagInput,
  platformsForFormat,
  readinessSummary,
  type DraftForm,
  type ExportedAsset,
} from "./publishingDashboardModel.ts";

/**
 * Publishing dashboard: write and track what each export will say on
 * YouTube, Instagram and TikTok.
 *
 * Drafts are planning data. Nothing here uploads, schedules, creates a
 * publish job or changes an export; "Posted" is the operator's own record of
 * a manual post. Whether a draft may be marked ready is the server's answer
 * (current export, text within the platform's limits), shown as it gave it.
 */

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, { code: "INTERNAL_ERROR", message: cause instanceof Error ? cause.message : String(cause) });

type Editing =
  | { readonly kind: "new"; readonly form: DraftForm }
  | { readonly kind: "existing"; readonly view: PublicationDraftView; readonly form: DraftForm };

export const PublishingDashboard: React.FC<{
  readonly tracks: readonly TrackSummaryView[];
}> = ({ tracks }) => {
  const [drafts, setDrafts] = useState<readonly PublicationDraftView[] | null>(null);
  const [unreadable, setUnreadable] = useState(0);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const reload = useCallback(async () => {
    try {
      const result = await listPublicationDrafts();
      setDrafts(result.drafts);
      setUnreadable(result.problems.length);
    } catch (cause) {
      setError(asApiError(cause));
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload, tracks]);

  const assets = exportedAssets(tracks);
  const titleOf = (slug: string) => tracks.find((track) => track.slug === slug)?.title ?? slug;

  const startDraft = async (asset: ExportedAsset) => {
    setError(null);
    setBusy(true);
    try {
      // The package's copy is only a starting point; without one the draft starts from the track title.
      const pkg = await getContentPackage(asset.slug).catch(() => null);
      setEditing({ kind: "new", form: newDraftForm(asset, pkg) });
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (editing === null) return;
    setError(null);
    setBusy(true);
    try {
      const saved =
        editing.kind === "new"
          ? await createPublicationDraft(draftFields(editing.form))
          : await updatePublicationDraft(editing.view.draft.draftId, editing.view.draft.revision, draftFields(editing.form));
      setEditing({ kind: "existing", view: saved, form: formFromDraft(saved) });
      await reload();
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const update = (changes: Partial<DraftForm>) =>
    setEditing((current) => (current === null ? null : { ...current, form: { ...current.form, ...changes } }));

  return (
    <div className="publishing">
      {error ? <ErrorBanner error={error} title="Publishing dashboard" /> : null}

      <h4 className="section__subtitle">Exported assets</h4>
      {assets.length === 0 ? (
        <p className="muted">No exports yet. Render a track first; drafts are written for an existing export.</p>
      ) : (
        <table className="publish__history">
          <thead>
            <tr>
              <th>Track</th>
              <th>Format</th>
              <th>Renderer</th>
              <th>Export</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => (
              <tr key={`${asset.slug}:${asset.format}`}>
                <td>{asset.title}</td>
                <td>{asset.label}</td>
                <td>{RENDERER_LABELS[asset.renderer]}</td>
                <td>
                  <span className={`librarybadge librarybadge--${asset.freshness === "invalid" ? "missing" : asset.freshness}`}>
                    {asset.freshness}
                  </span>
                </td>
                <td>
                  <button
                    type="button"
                    className="button button--quiet button--tiny"
                    disabled={busy || platformsForFormat(asset.format).length === 0}
                    onClick={() => void startDraft(asset)}
                  >
                    New draft
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h4 className="section__subtitle">Drafts</h4>
      {unreadable > 0 ? (
        <p className="note note--warning">
          <span className="note__message">
            {unreadable} draft file{unreadable === 1 ? "" : "s"} in out/.publishing/drafts/ could not be read and{" "}
            {unreadable === 1 ? "is" : "are"} left untouched.
          </span>
        </p>
      ) : null}
      {drafts === null ? (
        <p className="muted">Loading drafts…</p>
      ) : drafts.length === 0 ? (
        <p className="muted">No drafts yet.</p>
      ) : (
        <table className="publish__history">
          <thead>
            <tr>
              <th>Platform</th>
              <th>Track</th>
              <th>Title</th>
              <th>Status</th>
              <th>Readiness</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {drafts.map((view) => (
              <tr key={view.draft.draftId}>
                <td>{DRAFT_PLATFORM_LABELS[view.draft.platform]}</td>
                <td>
                  {titleOf(view.draft.source.track)} · {RENDER_PRESETS[view.draft.source.format].shortLabel} ·{" "}
                  {RENDERER_LABELS[view.draft.source.renderer]}
                </td>
                <td>{view.draft.title || <span className="muted">(untitled)</span>}</td>
                <td>
                  <span className={`librarybadge draftbadge--${view.draft.status}`}>{DRAFT_STATUS_LABELS[view.draft.status]}</span>
                </td>
                <td className={view.problems.length === 0 ? "" : "muted"}>{readinessSummary(view)}</td>
                <td>
                  <button
                    type="button"
                    className="button button--quiet button--tiny"
                    disabled={busy}
                    onClick={() => {
                      setError(null);
                      setEditing({ kind: "existing", view, form: formFromDraft(view) });
                    }}
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {editing === null ? null : (
        <DraftEditor
          editing={editing}
          trackTitle={titleOf(editing.form.track)}
          busy={busy}
          onChange={update}
          onSave={() => void save()}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
};

const DraftEditor: React.FC<{
  readonly editing: Editing;
  readonly trackTitle: string;
  readonly busy: boolean;
  readonly onChange: (changes: Partial<DraftForm>) => void;
  readonly onSave: () => void;
  readonly onClose: () => void;
}> = ({ editing, trackTitle, busy, onChange, onSave, onClose }) => {
  const { form } = editing;
  const rules = DRAFT_PLATFORM_RULES[form.platform];
  const hashtagCount = parseHashtagInput(form.hashtags).length;
  const saved = editing.kind === "existing" ? editing.view : null;

  return (
    <section className="publishing__editor" aria-label="Publication draft">
      <h4 className="section__subtitle">
        {saved === null ? "New draft" : `Draft · revision ${saved.draft.revision}`} — {trackTitle} ·{" "}
        {RENDER_PRESETS[form.format].shortLabel} · {RENDERER_LABELS[form.renderer]}
      </h4>
      <div className="form__grid">
        <label className="field">
          <span className="field__label">Platform</span>
          <select
            className="field__input"
            value={form.platform}
            onChange={(event) => onChange({ platform: event.target.value as DraftPlatform })}
          >
            {platformsForFormat(form.format).map((platform) => (
              <option key={platform} value={platform}>
                {DRAFT_PLATFORM_LABELS[platform]}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field__label">Status</span>
          <select
            className="field__input"
            value={form.status}
            onChange={(event) => onChange({ status: event.target.value as DraftStatus })}
          >
            {DRAFT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {DRAFT_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <span className="field__hint">Ready and Posted need a current export and text within the platform&apos;s limits.</span>
        </label>
        <label className="field">
          <span className="field__label">Title</span>
          <input
            className="field__input"
            value={form.title}
            onChange={(event) => onChange({ title: event.target.value })}
          />
          <span className="field__hint">
            {form.title.trim().length}/{rules.titleMaxLength}
          </span>
        </label>
        <label className="field">
          <span className="field__label">Hashtags</span>
          <input
            className="field__input"
            value={form.hashtags}
            placeholder="#lofi #beats"
            onChange={(event) => onChange({ hashtags: event.target.value })}
          />
          <span className="field__hint">
            {hashtagCount}/{rules.maxHashtags} · one word each, separated by spaces or commas
          </span>
        </label>
      </div>
      <label className="field">
        <span className="field__label">{rules.descriptionLabel}</span>
        <textarea
          className="field__input"
          rows={6}
          value={form.description}
          onChange={(event) => onChange({ description: event.target.value })}
        />
        <span className="field__hint">
          {form.description.trim().length}/{rules.descriptionMaxLength}
        </span>
      </label>

      {saved !== null && saved.problems.length > 0 ? (
        <ul className="notes">
          {saved.problems.map((problem, index) => (
            <li key={index} className="note note--info">
              <span className="note__message">{problem.message}</span>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="form__actions">
        <button type="button" className="button" disabled={busy} onClick={onSave}>
          {busy ? "Saving…" : saved === null ? "Create draft" : "Save draft"}
        </button>
        <button type="button" className="button button--quiet" disabled={busy} onClick={onClose}>
          Close
        </button>
        <span className="muted">Saved in out/.publishing/drafts/. Nothing is uploaded.</span>
      </div>
    </section>
  );
};
