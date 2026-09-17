import { useEffect, useState } from "react";
import type {
  TrackDetailView,
  TrackMetadataPatch,
} from "../../src/domain/api/views.ts";
import { ApiRequestError, updateTrackMetadata } from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

type Fields = {
  readonly title: string;
  readonly artist: string;
  readonly key: string;
  readonly bpm: string;
  readonly subtitle: string;
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
  };
};

const toPatch = (fields: Fields): TrackMetadataPatch => ({
  title: fields.title.trim(),
  artist: fields.artist.trim(),
  key: fields.key.trim(),
  bpm: fields.bpm.trim() === "" ? null : Number(fields.bpm),
  subtitle: fields.subtitle.trim(),
});

const sameFields = (a: Fields, b: Fields): boolean =>
  a.title === b.title &&
  a.artist === b.artist &&
  a.key === b.key &&
  a.bpm === b.bpm &&
  a.subtitle === b.subtitle;

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

  // Re-seed when a different track is selected, or when the file changed on
  // disk and the parent re-fetched.
  useEffect(() => {
    const next = toFields(track);

    setInitial(next);
    setFields(next);
    setError(null);
    setSavedAt(null);
  }, [track]);

  const dirty = !sameFields(fields, initial);
  const editable = track.metadataPresent && track.status !== "invalid";

  const update = (name: keyof Fields) => (value: string) => {
    setFields((previous) => ({ ...previous, [name]: value }));
    setSavedAt(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);

    try {
      await updateTrackMetadata(track.slug, toPatch(fields));
      setSavedAt(Date.now());
      // The parent re-reads the track, which re-seeds this form from disk.
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError
          ? cause
          : new ApiRequestError(0, {
              code: "INTERNAL_ERROR",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
      );
    } finally {
      setSaving(false);
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

      <div className="form__actions">
        <button className="button" type="submit" disabled={saving || !dirty}>
          {saving ? "Saving…" : "Save metadata"}
        </button>
        <button
          className="button button--quiet"
          type="button"
          disabled={saving || !dirty}
          onClick={() => {
            setFields(initial);
            setError(null);
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
