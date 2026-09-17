import { useState } from "react";
import { slugify } from "../../src/domain/tracks/slug.ts";
import { ApiRequestError, createTrack } from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

/**
 * Creates a track folder from a title.
 *
 * The slug preview uses the same slugify() the server does — imported from the
 * shared domain layer rather than reimplemented — so what is shown is exactly
 * the folder that will be created.
 *
 * Only metadata.json is written here. Cover and audio are uploaded afterwards
 * on the track's own panel, which keeps creation from half-failing partway
 * through a multi-file sequence.
 */
export const NewTrackPanel: React.FC<{
  readonly onCreated: (slug: string) => void;
  readonly onCancel: () => void;
}> = ({ onCreated, onCancel }) => {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);

  const trimmed = title.trim();
  const slug = slugify(trimmed);

  const submit = async () => {
    setBusy(true);
    setError(null);

    try {
      const track = await createTrack(trimmed);

      setTitle("");
      onCreated(track.slug);
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
      setBusy(false);
    }
  };

  return (
    <form
      className="newtrack"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="section__title">New track</h3>

      {error ? <ErrorBanner error={error} title="Could not create" /> : null}

      <label className="field">
        <span className="field__label">Title</span>
        <input
          className="field__input"
          value={title}
          placeholder="Midnight Rider"
          disabled={busy}
          autoFocus
          onChange={(event) => setTitle(event.target.value)}
        />
        <span className="field__hint">
          {slug
            ? `Creates public/tracks/${slug}/`
            : "The folder name is derived from the title."}
        </span>
      </label>

      <div className="form__actions">
        <button className="button" type="submit" disabled={busy || slug === ""}>
          {busy ? "Creating…" : "Create track"}
        </button>
        <button
          className="button button--quiet"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
      </div>
    </form>
  );
};
