import { useEffect, useMemo, useRef, useState } from "react";
import {
  PLACEHOLDER_KEYS,
  resolveMetadataTemplates,
  type MetadataTemplatesResetPatch,
  type PartialMetadataTemplates,
} from "../../core/domain/content/metadataTemplates.ts";
import { buildPlatformMetadata, type PlatformMetadataSubject } from "../../core/domain/content/platformMetadata.ts";
import type { ContentMetadataSettingsView } from "../../core/domain/api/views.ts";
import { ApiRequestError, updateContentMetadataSettings } from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";
import {
  TEMPLATE_FIELDS,
  templateFieldValue,
  withTemplateField,
} from "./templateFields.ts";

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

/** Shown when no track is open, so the preview is never blank. */
const SAMPLE_SUBJECT: PlatformMetadataSubject = {
  title: "Sample Track",
  artist: "Toshi",
  key: "C Major",
  bpm: 120,
  subtitle: "A sample tagline for previewing templates.",
};

/** The minimal reset-patch that turns `original` into `draft`, field by field. */
const diffTemplates = (
  original: PartialMetadataTemplates,
  draft: PartialMetadataTemplates,
): MetadataTemplatesResetPatch => {
  const patch: Record<string, Record<string, string | null>> = {};
  for (const { platform, field } of TEMPLATE_FIELDS) {
    const before = templateFieldValue(original, platform, field);
    const after = templateFieldValue(draft, platform, field);
    if (before === after) continue;
    patch[platform] = { ...patch[platform], [field]: after ?? null };
  }
  return patch as MetadataTemplatesResetPatch;
};

/**
 * The layer between a track's own overrides and the built-in defaults.
 *
 * Every field always shows real text — either the global override or the
 * built-in default it currently resolves to — so there is never a blank box
 * to puzzle over. Typing into a field marks it overridden; "Reset to
 * built-in" clears that one field back to inheriting, distinct from clearing
 * a track's own override (§ handoff, "Reset / clear override").
 */
export const ContentMetadataSettingsPanel: React.FC<{
  readonly settings: ContentMetadataSettingsView;
  /** The open track's fields, for a representative preview; null uses a sample. */
  readonly previewSubject: PlatformMetadataSubject | null;
  readonly onChanged: () => void;
}> = ({ settings, previewSubject, onChanged }) => {
  const [baseline, setBaseline] = useState(settings);
  const [draft, setDraft] = useState<PartialMetadataTemplates>(settings.templates);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [saved, setSaved] = useState(false);
  // After our own save, the parent still holds its pre-save snapshot until
  // its reload finishes. Do not re-seed from that known-old snapshot.
  const awaitingParentRevision = useRef<string | null>(null);

  const dirty = useMemo(
    () => Object.keys(diffTemplates(baseline.templates, draft)).length > 0,
    [baseline.templates, draft],
  );

  // Re-seed when the server's answer changes, so an edit made elsewhere (the
  // CLI, or a hand-edited settings file) is reflected rather than overwritten.
  useEffect(() => {
    if (settings.revision === awaitingParentRevision.current) return;
    awaitingParentRevision.current = null;
    if (settings.revision !== baseline.revision && !dirty) {
      setBaseline(settings);
      setDraft(settings.templates);
      setSaved(false);
    }
  }, [settings, baseline.revision, dirty]);

  const resolved = useMemo(() => resolveMetadataTemplates(draft, null), [draft]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await updateContentMetadataSettings(diffTemplates(baseline.templates, draft), baseline.revision);
      awaitingParentRevision.current = settings.revision;
      setBaseline(result);
      setDraft(result.templates);
      setSaved(true);
      onChanged();
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  const subject = previewSubject ?? SAMPLE_SUBJECT;

  return (
    <section className="section">
      <h3 className="section__title">Content metadata templates</h3>
      <p className="muted">
        Global defaults for generated YouTube/Reels/Instagram copy. A track&rsquo;s
        own override (in its metadata editor) always wins over these; these win
        over the built-in Toshi defaults. Placeholders:{" "}
        {PLACEHOLDER_KEYS.map((key) => (
          <code key={key} style={{ marginRight: 6 }}>{`{${key}}`}</code>
        ))}
      </p>

      {error ? <ErrorBanner error={error} title="Could not save templates" /> : null}
      {settings.problem ? (
        <p className="note note--warning" role="status">
          <span className="note__message">{settings.problem}</span>
        </p>
      ) : null}
      {settings.revision !== baseline.revision &&
      settings.revision !== awaitingParentRevision.current && dirty ? (
        <p className="note note--warning" role="status">
          <span className="note__message">Templates changed elsewhere while you were editing. Your draft is preserved; saving will report a conflict. Copy your edits before reloading.</span>
        </p>
      ) : null}

      <div className="templates">
        {TEMPLATE_FIELDS.map(({ platform, field, label }) => {
          const overridden = templateFieldValue(draft, platform, field) !== undefined;
          const value = (resolved[platform] as Record<string, string>)[field];
          const previewMetadata = buildPlatformMetadata("preview-slug", platform, subject, resolved);
          const previewText =
            field === "keywordsTemplate"
              ? (previewMetadata.keywords ?? []).join(", ")
              : field === "hashtagsTemplate"
                ? (previewMetadata.hashtags ?? []).join(" ")
                : field === "captionTemplate"
                  ? (previewMetadata.caption ?? "")
                  : field === "descriptionTemplate"
                    ? (previewMetadata.description ?? "")
                    : (previewMetadata.title ?? "");

          return (
            <div className="templates__field" key={`${platform}.${field}`}>
              <label className="field">
                <span className="field__label">
                  {label} {overridden ? <em className="templates__badge">override</em> : <em className="templates__badge templates__badge--builtin">built-in</em>}
                </span>
                <textarea
                  className="field__input templates__textarea"
                  rows={field.includes("description") ? 5 : 2}
                  value={value}
                  disabled={busy}
                  onChange={(event) => {
                    setDraft((previous) => withTemplateField(previous, platform, field, event.target.value));
                    setSaved(false);
                  }}
                />
              </label>
              <div className="templates__row">
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={busy || !overridden}
                  onClick={() => {
                    setDraft((previous) => withTemplateField(previous, platform, field, undefined));
                    setSaved(false);
                  }}
                >
                  Reset to built-in
                </button>
                <span className="templates__preview" title="Live preview, using the exact renderer Content Package uses">
                  {previewText}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="form__actions">
        <button className="button" type="button" disabled={busy || !dirty} onClick={() => void save()}>
          {busy ? "Saving…" : "Save templates"}
        </button>
        <span className="muted">
          {dirty ? "Unsaved changes" : saved ? "Saved" : `Stored in ${settings.settingsPath.split("/").slice(-1)[0]}, not committed to git`}
        </span>
      </div>
    </section>
  );
};
