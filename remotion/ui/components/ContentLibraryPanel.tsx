import { useCallback, useEffect, useState } from "react";
import type {
  ContentLibraryAdoptView,
  ContentLibraryRecordView,
  ContentLibraryView,
} from "../../core/domain/api/views.ts";
import { formatBundleTimestamp, formatBytes } from "../../core/domain/delivery/releaseBundle.ts";
import {
  CONTENT_LIBRARY_MAX_LIMIT,
  EXPORT_KIND_LABELS,
  LIBRARY_ENTRY_STATUSES,
  LIBRARY_ENTRY_STATUS_LABELS,
  type ContentLibraryEntry,
} from "../../core/domain/library/contentLibrary.ts";
import { STALE_REASON_LABELS } from "../../core/domain/video/exportFreshness.ts";
import { isRenderPresetId } from "../../core/domain/video/renderPresets.ts";
import {
  adoptExistingExports,
  ApiRequestError,
  getContentLibrary,
  getContentLibraryRecord,
  reexportContentLibraryRecord,
  revealTrackOutput,
} from "../api/client.ts";
import { ErrorBanner } from "./ErrorBanner.tsx";

/**
 * The content library: every export this project has generated, which version
 * of each track and format is on disk now, and — when a destination is
 * configured — what went out.
 *
 * Deliberately an operational list, not a dashboard: filters, one row per
 * version, and an inline inspector. Every filter is a server query, so the
 * answers are identical to the CLI's. Nothing here edits or deletes a record;
 * the one render it can start (Re-export) goes through the normal render
 * queue, and the new version records itself when it completes.
 */

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

const PERIODS = [
  { value: "", label: "Everything" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
] as const;

const PAGE = 50;

const StatusBadge: React.FC<{ readonly status: ContentLibraryEntry["status"] }> = ({ status }) => (
  <span className={`librarybadge librarybadge--${status}`}>{LIBRARY_ENTRY_STATUS_LABELS[status]}</span>
);

/** "Original", "Re-export — Cover changed", or "Adopted". */
const kindText = (entry: ContentLibraryEntry): string => {
  const { record } = entry;
  if (record.source === "adopted") return "Added from disk";
  if (record.exportKind !== "reexport") return EXPORT_KIND_LABELS.original;
  const changed = record.replaces?.changed ?? [];
  return changed.length === 0
    ? `${EXPORT_KIND_LABELS.reexport} · no input changes`
    : `${EXPORT_KIND_LABELS.reexport} · ${changed.map((reason) => STALE_REASON_LABELS[reason]).join(", ")}`;
};

const deliveredText = (entry: ContentLibraryEntry): string | null =>
  entry.deliveries === null
    ? null
    : entry.deliveries.count === 0
      ? "Not delivered"
      : `Delivered ${entry.deliveries.count}×`;

/** The inline inspector for one version. */
const RecordDetail: React.FC<{
  readonly recordId: string;
  readonly onInspect: (recordId: string) => void;
  readonly onReexported: (batchId: string) => void;
}> = ({ recordId, onInspect, onReexported }) => {
  const [detail, setDetail] = useState<ContentLibraryRecordView | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const [queued, setQueued] = useState(false);

  useEffect(() => {
    let current = true;
    setDetail(null);
    setError(null);
    setQueued(false);
    getContentLibraryRecord(recordId)
      .then((result) => {
        if (current) setDetail(result);
      })
      .catch((cause: unknown) => {
        if (current) setError(asApiError(cause));
      });
    return () => {
      current = false;
    };
  }, [recordId]);

  if (error) return <ErrorBanner error={error} title="Could not read this version" />;
  if (detail === null) return <p className="muted">Loading…</p>;

  const { entry, versions, reexport } = detail;
  const { record } = entry;
  const onDisk = entry.status === "current" || entry.status === "stale";

  const reveal = async () => {
    if (!isRenderPresetId(record.preset.id)) return;
    setError(null);
    try {
      await revealTrackOutput(record.track.slug, record.preset.id);
    } catch (cause) {
      setError(asApiError(cause));
    }
  };

  const startReexport = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await reexportContentLibraryRecord(record.recordId);
      setQueued(true);
      onReexported(result.batch.id);
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="library__detail">
      <dl className="library__facts">
        <dt>Output</dt>
        <dd>
          <code>{record.output.path}</code> · {formatBytes(record.output.bytes)}
          {onDisk ? "" : " · no longer this file"}
        </dd>
        <dt>Generated</dt>
        <dd>{formatBundleTimestamp(record.generatedAt)}</dd>
        <dt>Kind</dt>
        <dd>
          {kindText(entry)}
          {record.replaces ? (
            record.replaces.recordId ? (
              <>
                {" · replaced "}
                <button type="button" className="button--link" onClick={() => onInspect(record.replaces!.recordId!)}>
                  the previous version
                </button>
              </>
            ) : (
              " · replaced an export from before the library"
            )
          ) : null}
        </dd>
        {entry.supersededBy ? (
          <>
            <dt>Replaced by</dt>
            <dd>
              <button type="button" className="button--link" onClick={() => onInspect(entry.supersededBy!)}>
                a later version
              </button>
            </dd>
          </>
        ) : null}
        {entry.deliveries ? (
          <>
            <dt>Delivery</dt>
            <dd>
              {entry.deliveries.count === 0
                ? "Not delivered while this was the current version"
                : `Delivered ${entry.deliveries.count}× · last ${formatBundleTimestamp(entry.deliveries.lastDeliveredAt!)}`}
            </dd>
          </>
        ) : null}
        <dt>Render job</dt>
        <dd>{record.renderJobId ?? (record.source === "adopted" ? "Unknown — added from an existing file" : "None (rendered from the command line)")}</dd>
        <dt>Format</dt>
        <dd>
          {record.preset.label} · {record.preset.width}×{record.preset.height} · {record.preset.fps} fps
        </dd>
        <dt>Template</dt>
        <dd>
          {record.template.composition} · {record.template.visualizerVersion}
        </dd>
        <dt>Fingerprint</dt>
        <dd>
          <code title={record.manifest.inputFingerprint}>{record.manifest.inputFingerprint.slice(0, 16)}…</code>
          {" · "}
          <code>{record.manifest.path}</code>
        </dd>
        <dt>Record</dt>
        <dd>
          <code>{record.recordId}</code>
        </dd>
      </dl>

      <div className="form__actions">
        {onDisk ? (
          <button type="button" className="button button--quiet" onClick={() => void reveal()}>
            Reveal file
          </button>
        ) : null}
        {reexport.allowed ? (
          <button type="button" className="button" disabled={busy || queued} onClick={() => void startReexport()}>
            {queued ? "Re-export queued" : busy ? "Queueing…" : "Re-export"}
          </button>
        ) : null}
      </div>
      {reexport.allowed ? (
        <p className="muted library__hint">
          {queued
            ? "Rendering now — the new version appears here when it finishes. This one stays as it is."
            : "Renders this track and format again from the track's current files. The new version gets its own entry; this one is never changed."}
        </p>
      ) : (
        <p className="muted library__hint">{reexport.reason}</p>
      )}

      {versions.length > 1 ? (
        <>
          <p className="exports__intentlabel">Every version of this format, oldest first</p>
          <ol className="library__versions">
            {versions.map((version) => (
              <li key={version.record.recordId}>
                <StatusBadge status={version.status} />
                {version.record.recordId === record.recordId ? (
                  <span className="library__versioncurrent">{formatBundleTimestamp(version.record.generatedAt)} · this version</span>
                ) : (
                  <button type="button" className="button--link" onClick={() => onInspect(version.record.recordId)}>
                    {formatBundleTimestamp(version.record.generatedAt)}
                  </button>
                )}
                <span className="muted">{kindText(version)}</span>
              </li>
            ))}
          </ol>
        </>
      ) : null}
    </div>
  );
};

export const ContentLibraryPanel: React.FC<{
  /** Bumped by the app when anything may have changed, e.g. a render finished. */
  readonly refreshToken: number;
  readonly onBatchStarted: (batchId: string) => void;
}> = ({ refreshToken, onBatchStarted }) => {
  const [library, setLibrary] = useState<ContentLibraryView | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [busy, setBusy] = useState(false);
  const [track, setTrack] = useState("");
  const [preset, setPreset] = useState("");
  const [status, setStatus] = useState("");
  const [kind, setKind] = useState("");
  const [period, setPeriod] = useState("");
  const [limit, setLimit] = useState(PAGE);
  const [inspected, setInspected] = useState<string | null>(null);
  const [adopted, setAdopted] = useState<ContentLibraryAdoptView | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setLibrary(
        await getContentLibrary({ track, preset, status, kind, since: period, limit }),
      );
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  }, [track, preset, status, kind, period, limit]);

  useEffect(() => {
    void load();
  }, [load, refreshToken]);

  // A different filter is a different list; start from the first page again.
  useEffect(() => {
    setLimit(PAGE);
  }, [track, preset, status, kind, period]);

  const adopt = async () => {
    setBusy(true);
    setError(null);
    try {
      setAdopted(await adoptExistingExports());
      await load();
    } catch (cause) {
      setError(asApiError(cause));
    } finally {
      setBusy(false);
    }
  };

  if (library === null) {
    return error ? <ErrorBanner error={error} title="Could not read the content library" /> : <p className="muted">Loading…</p>;
  }

  const { summary } = library;
  const inspect = (recordId: string) => setInspected((previous) => (previous === recordId ? null : recordId));

  return (
    <div className="history library">
      {error ? <ErrorBanner error={error} title="Content library request failed" /> : null}

      {library.statusNote ? (
        <p className="note note--warning" role="status">
          <span className="note__message">{library.statusNote}</span>
        </p>
      ) : null}

      <p className="history__summary">
        {summary.total === 0
          ? track
            ? "Nothing generated for this track yet."
            : "Nothing recorded yet."
          : `${summary.total} version${summary.total === 1 ? "" : "s"} of ${summary.tracks} track${summary.tracks === 1 ? "" : "s"} · ` +
            `${summary.byStatus.current} current · ${summary.byStatus.stale} stale · ${summary.byStatus.superseded} superseded` +
            (summary.byStatus.missing > 0 ? ` · ${summary.byStatus.missing} missing` : "")}
      </p>

      <div className="history__filters">
        <label className="field field--inline">
          <span className="field__label">Track</span>
          <select className="field__input" value={track} onChange={(changed) => setTrack(changed.target.value)}>
            <option value="">Every track</option>
            {library.knownTracks.map((known) => (
              <option key={known.slug} value={known.slug}>
                {known.title}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span className="field__label">Format</span>
          <select className="field__input" value={preset} onChange={(changed) => setPreset(changed.target.value)}>
            <option value="">Every format</option>
            {library.knownPresets.map((known) => (
              <option key={known.id} value={known.id}>
                {known.label}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span className="field__label">Status</span>
          <select className="field__input" value={status} onChange={(changed) => setStatus(changed.target.value)}>
            <option value="">Any status</option>
            {LIBRARY_ENTRY_STATUSES.map((option) => (
              <option key={option} value={option}>
                {LIBRARY_ENTRY_STATUS_LABELS[option]}
              </option>
            ))}
          </select>
        </label>
        <label className="field field--inline">
          <span className="field__label">Kind</span>
          <select className="field__input" value={kind} onChange={(changed) => setKind(changed.target.value)}>
            <option value="">Originals and re-exports</option>
            <option value="original">{EXPORT_KIND_LABELS.original}</option>
            <option value="reexport">{EXPORT_KIND_LABELS.reexport}</option>
          </select>
        </label>
        <label className="field field--inline">
          <span className="field__label">Generated</span>
          <select className="field__input" value={period} onChange={(changed) => setPeriod(changed.target.value)}>
            {PERIODS.map((option) => (
              <option key={option.label} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <button className="button button--quiet" type="button" disabled={busy} onClick={() => void load()}>
          {busy ? "Reading…" : "Refresh"}
        </button>
      </div>

      {library.formats ? (
        <ul className="library__formats" aria-label="Formats generated for this track">
          {library.formats.map((format) => (
            <li key={format.presetId} className="library__format">
              <span className="library__formatlabel">{format.label}</span>
              {format.versions === 0 ? (
                <span className="muted">Never generated</span>
              ) : (
                <>
                  <StatusBadge status={format.latestStatus!} />
                  <span className="muted">
                    {format.versions} version{format.versions === 1 ? "" : "s"} · latest{" "}
                    {formatBundleTimestamp(format.latestGeneratedAt!)}
                  </span>
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}

      {library.entries.length === 0 ? (
        summary.total === 0 && !track ? (
          <div className="library__empty">
            <p className="muted">
              Every completed render is recorded here automatically, from now on. Exports rendered before
              the library existed can be added from what is already on disk.
            </p>
            <div className="form__actions">
              <button type="button" className="button button--quiet" disabled={busy} onClick={() => void adopt()}>
                Add existing exports
              </button>
            </div>
          </div>
        ) : (
          <p className="muted">No versions match these filters.</p>
        )
      ) : (
        <>
          <p className="muted">
            Showing {library.entries.length} of {library.matched} matching version{library.matched === 1 ? "" : "s"}, newest first.
          </p>
          <ul className="library__list">
            {library.entries.map((entry) => {
              const { record } = entry;
              const open = inspected === record.recordId;
              const delivered = deliveredText(entry);
              return (
                <li key={record.recordId} className={`library__row${open ? " library__row--open" : ""}`}>
                  <div className="library__summaryrow">
                    <StatusBadge status={entry.status} />
                    <span className="history__track">{record.track.title}</span>
                    <span className="history__preset">{record.preset.label}</span>
                    <span className="history__when">{formatBundleTimestamp(record.generatedAt)}</span>
                    <span className="library__kind">{kindText(entry)}</span>
                    <span className="library__delivered">{delivered ?? ""}</span>
                    <button
                      type="button"
                      className="button button--quiet button--tiny"
                      aria-expanded={open}
                      aria-label={`${open ? "Close" : "Inspect"} ${record.track.title} ${record.preset.label}, ${formatBundleTimestamp(record.generatedAt)}`}
                      onClick={() => inspect(record.recordId)}
                    >
                      {open ? "Close" : "Inspect"}
                    </button>
                  </div>
                  {open ? (
                    <RecordDetail recordId={record.recordId} onInspect={setInspected} onReexported={onBatchStarted} />
                  ) : null}
                </li>
              );
            })}
          </ul>
          {/* A version inspected from a lineage link may not be on this page. */}
          {inspected !== null && !library.entries.some((entry) => entry.record.recordId === inspected) ? (
            <div className="library__row library__row--open">
              <div className="library__summaryrow">
                <span className="exports__intentlabel">Linked version</span>
                <span className="app__spacer" />
                <button type="button" className="button button--quiet button--tiny" onClick={() => setInspected(null)}>
                  Close
                </button>
              </div>
              <RecordDetail recordId={inspected} onInspect={setInspected} onReexported={onBatchStarted} />
            </div>
          ) : null}
          {library.matched > library.entries.length && limit < CONTENT_LIBRARY_MAX_LIMIT ? (
            <div className="form__actions">
              <button
                type="button"
                className="button button--quiet"
                disabled={busy}
                onClick={() => setLimit((previous) => Math.min(previous + PAGE, CONTENT_LIBRARY_MAX_LIMIT))}
              >
                Show more
              </button>
            </div>
          ) : null}
        </>
      )}

      {summary.total > 0 || track ? (
        <div className="form__actions">
          <button
            type="button"
            className="button button--quiet button--tiny"
            disabled={busy}
            title="Records exports already on disk that the library does not know about yet — for example, ones rendered before it existed. Safe to run again."
            onClick={() => void adopt()}
          >
            Add existing exports from disk
          </button>
        </div>
      ) : null}

      {adopted ? (
        <p className="muted">
          Added {adopted.adopted} existing export{adopted.adopted === 1 ? "" : "s"}
          {adopted.alreadyRecorded > 0 ? `; ${adopted.alreadyRecorded} already recorded` : ""}
          {adopted.skipped.length > 0 ? `; ${adopted.skipped.length} skipped` : ""}.
        </p>
      ) : null}
    </div>
  );
};
