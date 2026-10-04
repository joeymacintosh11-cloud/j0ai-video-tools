import { useEffect, useRef, useState } from "react";
import type {
  ContentMetadataSettingsView,
  PartialMetadataTemplates,
  RenderersView,
  TrackDetailView,
  TrackMetadataPatch,
} from "../../core/domain/api/views.ts";
import {
  resolveExportPresets,
  type RenderPresetId,
} from "../../core/domain/video/renderPresets.ts";
import {
  DEFAULT_RENDERER_ID,
  RENDERER_LABELS,
  resolveTrackRenderer,
  type RendererId,
} from "../../core/domain/video/renderers.ts";
import { ApiRequestError, updateTrackMetadata } from "../api/client.ts";
import { rendererPatch } from "../api/engineRequest.ts";
import { useStillCurrent } from "../hooks/useStillCurrent.ts";
import { ContentMetadataOverridesEditor } from "./ContentMetadataOverridesEditor.tsx";
import { EnginePicker } from "./EnginePicker.tsx";
import { ErrorBanner } from "./ErrorBanner.tsx";
import { FormatPicker } from "./FormatPicker.tsx";
import { decideSeed } from "./metadataSeed.ts";
import { templatesDiffer } from "./templateFields.ts";

type Fields = {
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: string;
  readonly subtitle: string;
  /** Always a concrete list here: an undeclared track shows what it resolves to. */
  readonly exportPresets: readonly RenderPresetId[];
  /** Always concrete here: an undeclared track shows the default it resolves to. */
  readonly renderer: RendererId;
  /** Empty means "use the slug", which is what the placeholder shows. */
  readonly deliveryFolder: string;
  /** Empty object means "inherit everything". */
  readonly contentMetadataOverrides: PartialMetadataTemplates;
};

/**
 * BPM is kept as a string while editing so a half-typed or cleared value does
 * not have to be coerced to a number on every keystroke.
 */
const toFields = (track: TrackDetailView): Fields => {
  const draft = track.metadataDraft;

  return {
    title: draft?.title ?? "",
    artist: draft?.artist ?? "",
    key: draft?.key ?? "",
    bpm: draft?.bpm === null || draft?.bpm === undefined ? "" : String(draft.bpm),
    subtitle: draft?.subtitle ?? "",
    // An undeclared track shows the formats it is treated as intending, so what
    // the boxes say is what "export missing" will actually do.
    exportPresets: resolveExportPresets(track.exportPresets),
    renderer: resolveTrackRenderer(track.renderer),
    deliveryFolder: track.deliveryFolder ?? "",
    contentMetadataOverrides: draft?.contentMetadataOverrides ?? {},
  };
};

const toPatch = (fields: Fields): TrackMetadataPatch => ({
  title: fields.title.trim(),
  artist: fields.artist.trim(),
  key: fields.key.trim(),
  bpm: fields.bpm.trim() === "" ? null : Number(fields.bpm),
  subtitle: fields.subtitle.trim(),
  exportPresets: fields.exportPresets,
  // The default is stored as "no preference", so a track that never picked an
  // engine keeps a metadata.json with no "renderer" key at all.
  renderer: fields.renderer === DEFAULT_RENDERER_ID ? null : fields.renderer,
  deliveryFolder: fields.deliveryFolder.trim(),
  // The form is always the whole desired set: an empty object clears every
  // override (inherit everything), matching updateTrackMetadata's "replace
  // the whole object, never deep-merge" convention.
  contentMetadataOverrides:
    Object.keys(fields.contentMetadataOverrides).length > 0
      ? fields.contentMetadataOverrides
      : null,
});

const sameFields = (a: Fields, b: Fields): boolean =>
  a.title === b.title &&
  a.artist === b.artist &&
  a.key === b.key &&
  a.bpm === b.bpm &&
  a.subtitle === b.subtitle &&
  a.deliveryFolder === b.deliveryFolder &&
  a.renderer === b.renderer &&
  a.exportPresets.length === b.exportPresets.length &&
  a.exportPresets.every((id, index) => id === b.exportPresets[index]) &&
  !templatesDiffer(a.contentMetadataOverrides, b.contentMetadataOverrides);

const Field: React.FC<{
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly hint?: string;
  readonly disabled: boolean;
}> = ({ label, value, onChange, placeholder, hint, disabled }) => (
  <label className="field">
    <span className="field__label">{label}</span>
    <input
      className="field__input"
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
    {hint ? <span className="field__hint">{hint}</span> : null}
  </label>
);

/** What the chosen engine means for this track, in one line under the picker. */
const engineHint = (renderer: RendererId, renderers: RenderersView | null): string => {
  const status = renderers?.renderers.find((entry) => entry.id === renderer);
  const name = RENDERER_LABELS[renderer];

  if (status?.state === "unavailable") {
    return `${name} is not available on this machine: ${status.problem ?? "it is not installed."}`;
  }
  if (status?.state === "not_configured") {
    return `${name} is not configured yet, so its renders stay unavailable until it is: ${status.problem ?? "check its local settings."}`;
  }
  if (renderer === DEFAULT_RENDERER_ID) {
    return "Renders started here use Remotion — the default, which every track without a choice uses.";
  }
  return `Renders started here use ${name}, into their own folder. Content packages, Export missing and delivery use this engine. After Effects renders run serially with a template built for this track; release bundles and destination repair remain Remotion-only.`;
};

/**
 * Edits metadata.json through the API.
 *
 * Nothing is validated here: the server re-validates the merged result before
 * writing, and an invalid patch is rejected without touching the file. So this
 * form's job is to submit what was typed and show whatever the server says.
 *
 * The slug is never editable — renaming a track's folder is not something a
 * title change is allowed to do.
 */
export const MetadataForm: React.FC<{
  readonly track: TrackDetailView;
  /** The global content-metadata templates; null while still loading. */
  readonly contentMetadataSettings: ContentMetadataSettingsView | null;
  /** Engine availability from GET /api/renderers; null while loading. */
  readonly renderers: RenderersView | null;
  readonly onSaved: () => void;
}> = ({ track, contentMetadataSettings, renderers, onSaved }) => {
  const [initial, setInitial] = useState<Fields>(() => toFields(track));
  const [fields, setFields] = useState<Fields>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  /** Set when the file changed on disk while an edit was in progress. */
  const [externallyChanged, setExternallyChanged] = useState(false);

  const dirty = !sameFields(fields, initial);

  // What the form was seeded from, which is what a conditional save must be
  // based on — not the newest revision the parent happens to have fetched.
  const seeded = useRef({
    slug: track.slug,
    revision: track.metadataRevision,
  });
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const stillCurrent = useStillCurrent(track.slug);

  useEffect(() => {
    const decision = decideSeed({
      switchedTrack: seeded.current.slug !== track.slug,
      revisionChanged: seeded.current.revision !== track.metadataRevision,
      dirty: dirtyRef.current,
    });

    if (decision === "ignore") {
      return;
    }

    if (decision === "keep-local-edits") {
      setExternallyChanged(true);
      return;
    }

    const next = toFields(track);

    seeded.current = { slug: track.slug, revision: track.metadataRevision };
    setInitial(next);
    setFields(next);
    setError(null);
    setSavedAt(null);
    setExternallyChanged(false);
  }, [track]);
  const editable = track.metadataPresent && track.status !== "invalid";

  const update = (name: keyof Fields) => (value: string) => {
    setFields((previous) => ({ ...previous, [name]: value }));
    setSavedAt(null);
  };

  /**
   * Saves the engine choice the moment it is made, on its own.
   *
   * It is not a draft field like the others: the Render panel and every
   * engine-aware view read the *saved* preference, so a choice waiting for
   * "Save metadata" would show After Effects here while rendering with
   * Remotion, and be lost by a reload. Only the renderer is written, against
   * the revision this form was seeded from; any other edits in progress stay
   * exactly as they are.
   */
  const saveEngine = async (next: RendererId) => {
    const slug = track.slug;
    const previous = fields.renderer;

    setFields((current) => ({ ...current, renderer: next }));
    setSaving(true);
    setError(null);

    try {
      const saved = await updateTrackMetadata(slug, rendererPatch(next), seeded.current.revision);

      if (!stillCurrent(slug)) {
        return;
      }

      // The write advanced the file's revision. Adopt it (and the saved
      // engine) so the refresh below is not mistaken for an outside edit.
      seeded.current = { slug, revision: saved.metadataRevision };
      setInitial((current) => ({ ...current, renderer: resolveTrackRenderer(saved.renderer) }));
      setSavedAt(Date.now());
      onSaved();
    } catch (cause) {
      if (!stillCurrent(slug)) {
        return;
      }

      // Not saved, so the picker goes back to what is.
      setFields((current) => ({ ...current, renderer: previous }));
      setError(
        cause instanceof ApiRequestError
          ? cause
          : new ApiRequestError(0, {
              code: "INTERNAL_ERROR",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
      );
    } finally {
      if (stillCurrent(slug)) {
        setSaving(false);
      }
    }
  };

  const save = async () => {
    const slug = track.slug;

    setSaving(true);
    setError(null);

    try {
      // Conditional on the revision this form was seeded from, so an edit made
      // elsewhere since then is reported as a conflict rather than overwritten.
      const saved = await updateTrackMetadata(
        slug,
        toPatch(fields),
        seeded.current.revision,
      );

      if (!stillCurrent(slug)) {
        return;
      }

      // Re-seed from the write's own response rather than waiting for the
      // parent's refresh. Without this the form stayed dirty against its old
      // baseline, so the refresh that follows a successful save arrived with a
      // changed revision and an edit still in progress — which is exactly the
      // shape of an external edit, and was reported to the user as a conflict
      // with their own save. The response is the authoritative post-write
      // state, so seeding from it leaves nothing to mistake.
      const next = toFields(saved);

      seeded.current = { slug, revision: saved.metadataRevision };
      setInitial(next);
      setFields(next);
      setSavedAt(Date.now());
      setExternallyChanged(false);
      // The parent re-reads the track, which re-seeds this form from disk.
      onSaved();
    } catch (cause) {
      if (!stillCurrent(slug)) {
        return;
      }

      setError(
        cause instanceof ApiRequestError
          ? cause
          : new ApiRequestError(0, {
              code: "INTERNAL_ERROR",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
      );
    } finally {
      if (stillCurrent(slug)) {
        setSaving(false);
      }
    }
  };

  if (!editable) {
    return (
      <p className="muted">
        {track.metadataPresent
          ? "metadata.json is malformed, so it cannot be edited here. Fix the JSON in an editor, then press Refresh."
          : "This track has no metadata.json yet."}
      </p>
    );
  }

  return (
    <form
      className="form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      {error ? <ErrorBanner error={error} title="Could not save" /> : null}

      {externallyChanged ? (
        <p className="note note--warning" role="status">
          <span className="note__message">
            metadata.json changed on disk while you were editing. Your changes
            are still here and have not been overwritten — saving now will be
            refused as a conflict. Use Revert to load the newer version, or copy
            your edits out first.
          </span>
        </p>
      ) : null}

      <div className="form__grid">
        <Field
          label="Title"
          value={fields.title}
          onChange={update("title")}
          disabled={saving}
        />
        <Field
          label="Artist"
          value={fields.artist}
          onChange={update("artist")}
          disabled={saving}
        />
        <Field
          label="Key"
          value={fields.key}
          onChange={update("key")}
          placeholder="F Minor"
          disabled={saving}
        />
        <Field
          label="BPM"
          value={fields.bpm}
          onChange={update("bpm")}
          placeholder="100"
          disabled={saving}
        />
      </div>

      <Field
        label="Subtitle"
        value={fields.subtitle}
        onChange={update("subtitle")}
        hint="Optional — shown under the title in the video."
        disabled={saving}
      />

      <Field
        label="Delivery folder"
        value={fields.deliveryFolder}
        onChange={update("deliveryFolder")}
        placeholder={track.slug}
        hint="Optional — the folder this track's exports are delivered into. Defaults to the track's folder name."
        disabled={saving}
      />

      <div className="field">
        <FormatPicker
          label="Intended exports"
          className="formats--field"
          selected={fields.exportPresets}
          disabled={saving}
          onChange={(next) => {
            setFields((previous) => ({ ...previous, exportPresets: next }));
            setSavedAt(null);
          }}
        />
        <span className="field__hint">
          {track.exportPresets === null
            ? "Not declared yet, so every format is assumed. Saving records this choice in metadata.json."
            : "Export missing queues only these formats for this track."}
        </span>
      </div>

      <div className="field">
        <EnginePicker
          className="formats--field"
          selected={fields.renderer}
          statuses={renderers?.renderers ?? null}
          disabled={saving}
          onChange={(next) => void saveEngine(next)}
        />
        <span className="field__hint">
          {engineHint(fields.renderer, renderers)} Saved as soon as you choose.
        </span>
      </div>

      <ContentMetadataOverridesEditor
        value={fields.contentMetadataOverrides}
        onChange={(next) => {
          setFields((previous) => ({ ...previous, contentMetadataOverrides: next }));
          setSavedAt(null);
        }}
        contentMetadataSettings={contentMetadataSettings}
        subject={{
          title: fields.title.trim() || track.slug,
          artist: fields.artist.trim() || "Toshi",
          key: fields.key.trim() || "—",
          bpm: fields.bpm.trim() === "" ? 0 : Number(fields.bpm),
          subtitle: fields.subtitle.trim() || undefined,
        }}
        slug={track.slug}
        disabled={saving}
      />

      <div className="form__actions">
        <button className="button" type="submit" disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save metadata"}
        </button>
        <button
          className="button button--quiet"
          type="button"
          disabled={saving || !(dirty || externallyChanged)}
          onClick={() => {
            // After an external change, revert means "take what is on disk
            // now", not "take what this form loaded a while ago".
            const next = externallyChanged ? toFields(track) : initial;

            seeded.current = {
              slug: track.slug,
              revision: track.metadataRevision,
            };
            setInitial(next);
            setFields(next);
            setError(null);
            setExternallyChanged(false);
          }}
        >
          Revert
        </button>
        <span className="muted">
          {dirty
            ? "Unsaved changes"
            : savedAt !== null
              ? "Saved"
              : `Folder: ${track.slug} (never renamed by a title change)`}
        </span>
      </div>
    </form>
  );
};
