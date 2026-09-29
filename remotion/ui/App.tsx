import { useCallback, useEffect, useRef, useState } from "react";
import {
  DEFAULT_RENDER_PRESET_ID,
  type RenderPresetId,
} from "../src/domain/video/renderPresets.ts";
import type { ContentPackageBatchApplyView, DestinationHealthView } from "../src/domain/api/views.ts";
import { PLATFORM_LIST, type PlatformId } from "../src/domain/content/platformProfiles.ts";
import {
  createRenderBatch,
  getContentMetadataSettings,
  getDeliverySettings,
  getTrack,
  listTracks,
} from "./api/client.ts";
import { ApiRequestError } from "./api/client.ts";
import { BatchContentPackagePanel } from "./components/BatchContentPackagePanel.tsx";
import { ContentLibraryPanel } from "./components/ContentLibraryPanel.tsx";
import { ContentMetadataSettingsPanel } from "./components/ContentMetadataSettingsPanel.tsx";
import { DeliverPanel } from "./components/DeliverPanel.tsx";
import { DeliveryHistoryPanel } from "./components/DeliveryHistoryPanel.tsx";
import { DeliverySettingsPanel } from "./components/DeliverySettingsPanel.tsx";
import { DestinationFixPlanPanel } from "./components/DestinationFixPlanPanel.tsx";
import { DestinationHealthPanel } from "./components/DestinationHealthPanel.tsx";
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
import {
  clearBatchSession,
  loadBatchSession,
  mergeSessionJobReferences,
  pruneSessionJobIds,
  reconcileBatchSession,
  saveBatchSession,
  toSessionJobReferences,
  type BatchSessionJobReference,
  type BatchSessionMode,
} from "./batchSession.ts";

const slugFromHash = (): string | null =>
  window.location.hash.replace(/^#/, "") || null;

export const App: React.FC = () => {
  const [initialBatchSession] = useState(() => loadBatchSession(window.localStorage));
  const restoreCandidate = useRef(initialBatchSession);
  const [batchSessionReady, setBatchSessionReady] = useState(restoreCandidate.current === null);
  // The selected track lives in the URL hash, so a reload (and Vite's HMR)
  // keeps you on the track you were looking at.
  const [selectedSlug, setSelectedSlug] = useState<string | null>(slugFromHash);
  const [creating, setCreating] = useState(false);
  const [showingSettings, setShowingSettings] = useState(false);
  const [showingHistory, setShowingHistory] = useState(false);
  const [showingLibrary, setShowingLibrary] = useState(false);
  // Bumped whenever anything may have changed (a render finished, the window
  // regained focus), so an open library re-reads without polling.
  const [libraryRefresh, setLibraryRefresh] = useState(0);
  const [showingBatchPackage, setShowingBatchPackage] = useState(false);
  const [batchMode, setBatchMode] = useState<BatchSessionMode>("intent");
  const [batchPlatforms, setBatchPlatforms] = useState<readonly PlatformId[]>(
    PLATFORM_LIST.map((platform) => platform.id),
  );
  /**
   * The last catalogue-wide destination scan, held in memory only. A scan is
   * always explicit (never run automatically on a poll or a render), so this
   * is simply whatever the last "Scan destination" click produced — never
   * persisted, never treated as live.
   */
  const [health, setHealth] = useState<DestinationHealthView | null>(null);

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
  /** Kept while the panel is closed so reopening can reattach to exact jobs. */
  const [contentPackageApply, setContentPackageApply] = useState<ContentPackageBatchApplyView | null>(null);
  const [contentPackageJobReferences, setContentPackageJobReferences] = useState<readonly BatchSessionJobReference[]>([]);
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
  const contentMetadataSettings = useAsync(getContentMetadataSettings, []);
  useEffect(() => {
    // A catalogue badge belongs to the destination that was scanned. Clear it
    // when the configured destination changes, including edits made elsewhere.
    if (health !== null && delivery.data !== null && health.root !== delivery.data.root) {
      setHealth(null);
    }
  }, [delivery.data, health]);
  const detail = useAsync(
    useCallback(
      () => (selectedSlug ? getTrack(selectedSlug) : Promise.resolve(null)),
      [selectedSlug],
    ),
    [selectedSlug],
  );

  // Catalogue data is authoritative for selection. Browser storage is not
  // applied until every stored slug can be intersected with the current list.
  useEffect(() => {
    if (batchSessionReady || tracks.data === null) return;
    const candidate = restoreCandidate.current;
    restoreCandidate.current = null;
    const restored = candidate
      ? reconcileBatchSession(candidate, new Set(tracks.data.map((track) => track.slug)))
      : null;
    if (restored) {
      setChecked(restored.selectedSlugs);
      setBatchMode(restored.mode);
      setBatchPlatforms(restored.platforms.length > 0
        ? restored.platforms
        : PLATFORM_LIST.map((platform) => platform.id));
      setContentPackageJobReferences(restored.jobReferences);
      setShowingBatchPackage(restored.panelOpen);
    } else {
      clearBatchSession(window.localStorage);
    }
    setBatchSessionReady(true);
  }, [batchSessionReady, tracks.data]);

  // Track deletion is also authoritative after initial restore. Additions are
  // never selected implicitly.
  useEffect(() => {
    if (!batchSessionReady || tracks.data === null) return;
    const available = new Set(tracks.data.map((track) => track.slug));
    setChecked((previous) => previous.filter((slug) => available.has(slug)));
    setContentPackageJobReferences((previous) => previous.filter((reference) => available.has(reference.slug)));
  }, [batchSessionReady, tracks.data]);

  useEffect(() => {
    if (!batchSessionReady) return;
    if (checked.length === 0) {
      clearBatchSession(window.localStorage);
      return;
    }
    const selected = new Set(checked);
    saveBatchSession(window.localStorage, {
      selectedSlugs: checked,
      mode: batchMode,
      platforms: batchMode === "platforms" ? batchPlatforms : [],
      jobReferences: contentPackageJobReferences.filter((reference) => selected.has(reference.slug)),
      panelOpen: showingBatchPackage,
    });
  }, [batchMode, batchPlatforms, batchSessionReady, checked, contentPackageJobReferences, showingBatchPackage]);

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
  const { reload: reloadContentMetadataSettings } = contentMetadataSettings;

  const refreshAll = useCallback(() => {
    reloadTracks();
    reloadDetail();
    reloadDelivery();
    reloadContentMetadataSettings();
    setLibraryRefresh((previous) => previous + 1);
  }, [reloadTracks, reloadDetail, reloadDelivery, reloadContentMetadataSettings]);

  useWindowFocus(refreshAll);

  const toggleChecked = useCallback((slug: string) => {
    setChecked((previous) =>
      previous.includes(slug)
        ? previous.filter((candidate) => candidate !== slug)
        : [...previous, slug],
    );
  }, []);

  // Always this exact listed set — there is no filter to hide a wider
  // catalogue behind, so "select all" can never silently reach past what is
  // visible right now.
  const selectAllTracks = useCallback(() => {
    setChecked((tracks.data ?? []).map((track) => track.slug));
  }, [tracks.data]);

  const clearSelection = useCallback(() => {
    clearBatchSession(window.localStorage);
    setChecked([]);
    setShowingBatchPackage(false);
    setContentPackageApply(null);
    setContentPackageJobReferences([]);
  }, []);

  const handleContentPackageApplied = useCallback((view: ContentPackageBatchApplyView) => {
    setContentPackageApply(view);
    const incoming = toSessionJobReferences(view.jobReferences);
    setContentPackageJobReferences((previous) => mergeSessionJobReferences(previous, incoming));
  }, []);

  const pruneContentPackageJobs = useCallback((jobIds: ReadonlySet<string>) => {
    setContentPackageJobReferences((previous) => pruneSessionJobIds(previous, jobIds));
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
      clearSelection();
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
          onClick={() => {
            setShowingSettings((previous) => !previous);
            setShowingHistory(false);
            setShowingLibrary(false);
          }}
        >
          {showingSettings ? "Close settings" : "Delivery"}
        </button>
        {/* Always offered: the library records every completed render,
            whether or not a delivery destination exists. */}
        <button
          type="button"
          className="button button--quiet"
          onClick={() => {
            setShowingLibrary((previous) => !previous);
            setShowingSettings(false);
            setShowingHistory(false);
          }}
        >
          {showingLibrary ? "Close library" : "Library"}
        </button>
        {/* Only once there is a destination: before that nothing can have
            been delivered, and the settings panel is where that is set. */}
        {delivery.data?.root === null ? null : (
          <button
            type="button"
            className="button button--quiet"
            onClick={() => {
              setShowingHistory((previous) => !previous);
              setShowingSettings(false);
              setShowingLibrary(false);
            }}
          >
            {showingHistory ? "Close history" : "History"}
          </button>
        )}
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
        {!batchSessionReady ? (
          <span className="muted">Restoring batch…</span>
        ) : checked.length > 0 ? (
          <>
            <span className="actions__result">
              {checked.length} track{checked.length === 1 ? "" : "s"} ×{" "}
              {formats.length} format{formats.length === 1 ? "" : "s"} ={" "}
              {targetCount} render{targetCount === 1 ? "" : "s"}
            </span>
            <button
              type="button"
              className="button button--quiet"
              onClick={clearSelection}
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
                clearSelection();
              }}
              onChanged={refreshAll}
            />
            <button
              type="button"
              className={`button button--quiet${showingBatchPackage ? " button--active" : ""}`}
              onClick={() => setShowingBatchPackage((previous) => !previous)}
            >
              {showingBatchPackage ? "Hide content packages" : "Inspect content packages"}
            </button>
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
      {contentMetadataSettings.error ? (
        <div className="app__toolbar app__toolbar--error">
          <ErrorBanner error={contentMetadataSettings.error} title="Could not load content metadata settings" />
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
            onSelectAll={selectAllTracks}
            onClearSelection={clearSelection}
            health={health}
          />
        )}

        {!batchSessionReady ? (
          <div className="placeholder">Restoring batch…</div>
        ) : detail.error ? (
          <div style={{ padding: 20 }}>
            <ErrorBanner error={detail.error} title="Could not load track" />
          </div>
        ) : showingBatchPackage && checked.length > 0 ? (
          <div className="detail">
            <BatchContentPackagePanel
              tracks={checked}
              hasDestination={Boolean(delivery.data && delivery.data.root !== null)}
              onQueued={setBatchId}
              mode={batchMode}
              platforms={batchPlatforms}
              jobReferences={contentPackageJobReferences}
              initialJobs={contentPackageApply?.renderBatch?.jobs ?? []}
              onModeChange={setBatchMode}
              onPlatformsChange={setBatchPlatforms}
              onApplied={handleContentPackageApplied}
              onJobIdsPruned={pruneContentPackageJobs}
              onChanged={refreshAll}
              onClose={() => setShowingBatchPackage(false)}
            />
          </div>
        ) : showingLibrary ? (
          <div className="detail">
            <section className="section">
              <h3 className="section__title">Content library</h3>
              <p className="muted">
                Every export generated for every track, and which version is on disk now.
                Recorded in <code>out/.content-library/library.jsonl</code> as each render
                completes, and never rewritten.
              </p>
              <ContentLibraryPanel refreshToken={libraryRefresh} onBatchStarted={setBatchId} />
            </section>
          </div>
        ) : showingHistory ? (
          <div className="detail">
            <section className="section">
              <h3 className="section__title">Delivery history</h3>
              <p className="muted">
                Every delivery to this destination, as it happened. Recorded in{" "}
                <code>delivery-log.jsonl</code> beside the delivered folders and
                never rewritten.
              </p>
              <DeliveryHistoryPanel onChanged={refreshAll} />
            </section>
          </div>
        ) : showingSettings ? (
          <div className="detail">
            {delivery.data ? (
              <>
                <DeliverySettingsPanel
                  settings={delivery.data}
                  onChanged={() => {
                    setHealth(null);
                    refreshAll();
                  }}
                />
                {delivery.data.root === null ? null : (
                  <section className="section">
                    <h3 className="section__title">Destination health</h3>
                    <p className="muted">
                      Compares the destination&rsquo;s actual contents against
                      current delivery receipts and release bundles. Nothing
                      here is ever written or deleted.
                    </p>
                    <DestinationHealthPanel tracks={null} onScanned={setHealth} />
                    <DestinationFixPlanPanel
                      tracks={null}
                      onApplied={() => {
                        setHealth(null);
                        refreshAll();
                      }}
                    />
                  </section>
                )}
              </>
            ) : (
              <div className="placeholder">Loading…</div>
            )}
            {contentMetadataSettings.data ? (
              <ContentMetadataSettingsPanel
                settings={contentMetadataSettings.data}
                previewSubject={
                  detail.data?.metadata
                    ? {
                        title: detail.data.metadata.title,
                        artist: detail.data.metadata.artist,
                        key: detail.data.metadata.key,
                        bpm: detail.data.metadata.bpm,
                        subtitle: detail.data.metadata.subtitle,
                      }
                    : null
                }
                onChanged={refreshAll}
              />
            ) : null}
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
            key={detail.data.slug}
            track={detail.data}
            formats={formats}
            contentMetadataSettings={contentMetadataSettings.data}
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
