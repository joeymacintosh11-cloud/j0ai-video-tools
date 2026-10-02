import { useEffect, useState } from "react";
import type { DeliverySettingsView } from "../../core/domain/api/views.ts";
import {
  ApiRequestError,
  revealDelivery,
  updateDeliverySettings,
} from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

/**
 * Where delivered copies go on this machine.
 *
 * A typed path rather than a native folder picker: a picker needs a desktop
 * shell this project deliberately does not have, and the server validates the
 * path properly either way — it must be absolute, exist, be a directory and sit
 * outside the project. Paste it from Finder with ⌘⌥C.
 *
 * This is the only place in the app where a filesystem path is entered. Every
 * delivery afterwards names tracks and formats, and the server resolves the
 * destination itself.
 */
export const DeliverySettingsPanel: React.FC<{
  readonly settings: DeliverySettingsView;
  readonly onChanged: () => void;
}> = ({ settings, onChanged }) => {
  const [root, setRoot] = useState(settings.root ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [saved, setSaved] = useState(false);

  // Re-seed when the server's answer changes, so an external edit to
  // delivery.local.json is reflected rather than silently overwritten.
  useEffect(() => {
    setRoot(settings.root ?? "");
    setSaved(false);
  }, [settings.root]);

  const dirty = root.trim() !== (settings.root ?? "");

  const save = async (patch: Parameters<typeof updateDeliverySettings>[0]) => {
    setBusy(true);
    setError(null);

    try {
      await updateDeliverySettings(patch);
      setSaved(true);
      onChanged();
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="section">
      <h3 className="section__title">Delivery destination</h3>

      {error ? (
        <ErrorBanner error={error} title="Could not save the destination" />
      ) : null}

      {settings.root !== null && !settings.available ? (
        <p className="note note--warning" role="status">
          <span className="note__message">
            {settings.problem ??
              "The configured destination is not available right now."}
          </span>
        </p>
      ) : null}

      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault();
          void save({ root: root.trim() === "" ? null : root.trim() });
        }}
      >
        <label className="field">
          <span className="field__label">Destination folder</span>
          <input
            className="field__input"
            value={root}
            placeholder="/Users/you/Movies/Toshi Exports"
            disabled={busy}
            spellCheck={false}
            onChange={(event) => {
              setRoot(event.target.value);
              setSaved(false);
            }}
          />
          <span className="field__hint">
            An absolute path to an existing folder outside this project — a
            Movies folder, a release folder, or a locally synced Dropbox or
            Drive folder. Leave it empty to turn delivery off. Stored in{" "}
            <code>{settings.settingsPath.split("/").slice(-1)[0]}</code>, which
            is not committed to git.
          </span>
        </label>

        <div className="form__actions">
          <button className="button" type="submit" disabled={busy || !dirty}>
            {busy ? "Saving…" : "Save destination"}
          </button>
          <button
            className="button button--quiet"
            type="button"
            disabled={busy || settings.root === null || !settings.available}
            onClick={() => void revealDelivery().catch(() => undefined)}
          >
            Reveal in Finder
          </button>
          <label className="format" title="Copy each export as soon as it finishes rendering">
            <input
              type="checkbox"
              checked={settings.autoDeliver}
              disabled={busy || settings.root === null}
              onChange={(event) =>
                void save({ autoDeliver: event.target.checked })
              }
            />
            <span className="format__name">Deliver after each render</span>
          </label>
          <label
            className="format"
            title="Rewrite release.json and release.md after a successful delivery"
          >
            <input
              type="checkbox"
              checked={settings.autoUpdateReleaseBundle}
              disabled={busy || settings.root === null}
              onChange={(event) =>
                void save({ autoUpdateReleaseBundle: event.target.checked })
              }
            />
            <span className="format__name">Update release bundles</span>
          </label>
          <span className="muted">
            {dirty
              ? "Unsaved change"
              : saved
                ? "Saved"
                : settings.root === null
                  ? "Delivery is off"
                  : "Delivery is on"}
          </span>
        </div>
      </form>
    </section>
  );
};
