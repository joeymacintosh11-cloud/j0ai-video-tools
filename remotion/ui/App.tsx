import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_RENDER_PRESET_ID,
  type RenderPresetId,
} from "../src/domain/video/renderPresets.ts";
import {
  createRenderBatch,
  getDeliverySettings,
  getTrack,
  listTracks,
} from "./api/client.ts";
import { ApiRequestError } from "./api/client.ts";
import { DeliverPanel } from "./components/DeliverPanel.tsx";
import { DeliverySettingsPanel } from "./components/DeliverySettingsPanel.tsx";
import { ReleaseBundlePanel } from "./components/ReleaseBundlePanel.tsx";
import { ErrorBanner } from "./components/ErrorBanner.tsx";
import { ExportMissingPanel } from "./components/ExportMissingPanel.tsx";
import { FormatPicker } from "./components/FormatPicker.tsx";
import { NewTrackPanel } from "./components/NewTrackPanel.tsx";
import { QueueDrawer } from "./components/QueueDrawer.tsx";
import { TrackDetail } from "./components/TrackDetail.tsx";
import { TrackList } from "./components/TrackList.tsx";
import { useAsync } from "./hooks/useAsync.ts";
import { useWindowFocus } from "./hooks/useWindowFocus.ts";

const slugFromHash = (): string | null =>
  window.location.hash.replace(/^#/, "") || null;

export const App: React.FC = () => {
  // The selected track lives in the URL hash, so a reload (and Vite's HMR)
  // keeps you on the track you were looking at.
  const [selectedSlug, setSelectedSlug] = useState<string | null>(slugFromHash);
  const [creating, setCreating] = useState(false);
  const [showingSettings, setShowingSettings] = useState(false);

  /**
   * Which formats to render. Shared by the single-track Render button and by
   * batching, so there is one answer to "what am I exporting" on screen. It
   * starts as 16:9 alone, which is what a render produced before presets.
   */
  const [formats, setFormats] = useState<readonly RenderPresetId[]>([
    DEFAULT_RENDER_PRESET_ID,
  ]);
  /** Tracks ticked for a batch. Empty means the single-track workflow. */
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [queueError, setQueueError] = useState<ApiRequestError | null>(null);

  const select = useCallback((slug: string) => {
    window.location.hash = slug;
    setSelectedSlug(slug);
  }, []);

  useEffect(() => {
    const onHashChange = () => setSelectedSlug(slugFromHash());

    window.addEventListener("hashchange", onHashChange);

    return () => {
      window.removeEventListener("hashchange", onHashChange);
    };
  }, []);

  const tracks = useAsync(listTracks, []);
  const delivery = useAsync(getDeliverySettings, []);
  const detail = useAsync(
    useCallback(
      () => (selectedSlug ? getTrack(selectedSlug) : Promise.resolve(null)),
      [selectedSlug],
    ),
    [selectedSlug],
  );

  // Select the first track once the list arrives, so the app opens on content
  // rather than an empty panel.
  useEffect(() => {
    if (selectedSlug === null && tracks.data && tracks.data.length > 0) {
      select(tracks.data[0].slug);
    }
  }, [tracks.data, selectedSlug, select]);

  // metadata.json may be edited outside the app; re-read on focus. Both reload
  // functions are stable, so destructuring keeps this callback stable too.
  const { reload: reloadTracks } = tracks;
  const { reload: reloadDetail } = detail;

  const { reload: reloadDelivery } = delivery;

  const refreshAll = useCallback(() => {
    reloadTracks();
    reloadDetail();
    reloadDelivery();
  }, [reloadTracks, reloadDetail, reloadDelivery]);

  useWindowFocus(refreshAll);

  const toggleChecked = useCallback((slug: string) => {
    setChecked((previous) =>
      previous.includes(slug)
        ? previous.filter((candidate) => candidate !== slug)
        : [...previous, slug],
    );
  }, []);

  /** Queues every ticked track in every ticked format. */
  const queueSelected = async () => {
    setQueueError(null);

    const targets = checked.flatMap((slug) =>
      formats.map((preset) => ({ slug, preset })),
    );

    try {
      const created = await createRenderBatch(targets);

      setBatchId(created.batchId);
      setChecked([]);
      refreshAll();
    } catch (cause) {
      setQueueError(
        cause instanceof ApiRequestError
          ? cause
          : new ApiRequestError(0, {
              code: "INTERNAL_ERROR",
              message: cause instanceof Error ? cause.message : String(cause),
            }),
      );
    }
  };

  const targetCount = checked.length * formats.length;

  return (
    <div className={`app${batchId === null ? "" : " app--queue"}`}>
      <header className="app__header">
        <h1 className="app__title">Toshi Visualizer</h1>
        <span className="app__subtitle">Local render tool</span>
        <span className="app__spacer" />
        <button
          type="button"
          className="button"
          onClick={() => setCreating((previous) => !previous)}
        >
          {creating ? "Close" : "New track"}
        </button>
        <button
          type="button"
          className="button button--quiet"
          onClick={() => setShowingSettings((previous) => !previous)}
        >
          {showingSettings ? "Close settings" : "Delivery"}
        </button>
        <button
          type="button"
          className="button button--quiet"
          onClick={refreshAll}
        >
          Refresh
        </button>
      </header>

      <div className="app__toolbar">
        <FormatPicker selected={formats} onChange={setFormats} />

        <span className="app__spacer" />

        <ExportMissingPanel
          label="Export missing for catalogue"
          tracks={null}
          formats={null}
          onQueued={setBatchId}
          onChanged={refreshAll}
        />

        {/* Only offered once a destination exists; there is nothing to
            deliver to before that, and the settings panel says so. */}
        {delivery.data?.root === null ? null : (
          <>
            <DeliverPanel
              label="Deliver current catalogue exports"
              tracks={null}
              onChanged={refreshAll}
            />
            <ReleaseBundlePanel
              label="Update release bundles"
              tracks={null}
              onChanged={refreshAll}
            />
          </>
        )}
      </div>

      <div className="app__toolbar app__toolbar--selection">
        {checked.length > 0 ? (
          <>
            <span className="actions__result">
              {checked.length} track{checked.length === 1 ? "" : "s"} ×{" "}
              {formats.length} format{formats.length === 1 ? "" : "s"} ={" "}
              {targetCount} render{targetCount === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              className="button button--quiet"
              onClick={() => setChecked([])}
            >
              Clear
            </button>
            <button
              type="button"
              className="button"
              onClick={() => void queueSelected()}
            >
              Add to render queue
            </button>
            <ExportMissingPanel
              label="Export missing for selected"
              tracks={checked}
              formats={null}
              onQueued={(id) => {
                setBatchId(id);
                setChecked([]);
              }}
              onChanged={refreshAll}
            />
          </>
        ) : (
          <span className="muted">
            Tick tracks to queue several at once, or render the open track
            below. Export missing uses each track&rsquo;s intended formats.
          </span>
        )}
      </div>

      {queueError ? (
        <div className="app__toolbar app__toolbar--error">
          <ErrorBanner error={queueError} title="Could not queue renders" />
        </div>
      ) : null}

      <div className="app__body">
        {tracks.error ? (
          <div style={{ padding: 20 }}>
            <ErrorBanner error={tracks.error} title="Could not load tracks" />
          </div>
        ) : (
          <TrackList
            tracks={tracks.data ?? []}
            selectedSlug={selectedSlug}
            onSelect={select}
            checked={checked}
            onToggleChecked={toggleChecked}
          />
        )}

        {detail.error ? (
          <div style={{ padding: 20 }}>
            <ErrorBanner error={detail.error} title="Could not load track" />
          </div>
        ) : showingSettings ? (
          <div className="detail">
            {delivery.data ? (
              <DeliverySettingsPanel
                settings={delivery.data}
                onChanged={refreshAll}
              />
            ) : (
              <div className="placeholder">Loading…</div>
            )}
          </div>
        ) : creating ? (
          <div className="detail">
            <NewTrackPanel
              onCreated={(slug) => {
                setCreating(false);
                reloadTracks();
                select(slug);
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        ) : detail.data ? (
          <TrackDetail
            track={detail.data}
            formats={formats}
            onChanged={refreshAll}
            onBatchStarted={setBatchId}
          />
        ) : (
          <div className="placeholder">
            {tracks.loading || detail.loading ? "Loading…" : "Select a track"}
          </div>
        )}
      </div>

      <QueueDrawer
        batchId={batchId}
        onChanged={refreshAll}
        onDismiss={() => setBatchId(null)}
      />
    </div>
  );
};
