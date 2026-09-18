import { useEffect, useRef, useState } from "react";
import type {
  TrackDetailView,
  TrackMetadataPatch,
} from "../../src/domain/api/views.ts";
import {
  resolveExportPresets,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";
import { ApiRequestError, updateTrackMetadata } from "../api/client.ts";
import { useStillCurrent } from "../hooks/useStillCurrent.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";
import { FormatPicker } from "./FormatPicker.tsx";
import { decideSeed } from "./metadataSeed.ts";

type Fields = {
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: string;
  readonly subtitle: string;
  /** Always a concrete list here: an undeclared track shows what it resolves to. */
  readonly exportPresets: readonly RenderPresetId[];
  /** Empty means "use the slug", which is what the placeholder shows. */
  readonly deliveryFolder: string;
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
    deliveryFolder: track.deliveryFolder ?? "",
  };
};

const toPatch = (fields: Fields): TrackMetadataPatch => ({
  title: fields.title.trim(),
  artist: fields.artist.trim(),
  key: fields.key.trim(),
  bpm: fields.bpm.trim() === "" ? null : Number(fields.bpm),
  subtitle: fields.subtitle.trim(),
  exportPresets: fields.exportPresets,
  deliveryFolder: fields.deliveryFolder.trim(),
});

const sameFields = (a: Fields, b: Fields): boolean =>
  a.title === b.title &&
  a.artist === b.artist &&
  a.key === b.key &&
  a.bpm === b.bpm &&
  a.subtitle === b.subtitle &&
  a.deliveryFolder === b.deliveryFolder &&
  a.exportPresets.length === b.exportPresets.length &&
  a.exportPresets.every((id, index) => id === b.exportPresets[index]);

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
  readonly onSaved: () => void;
}> = ({ track, onSaved }) => {
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
