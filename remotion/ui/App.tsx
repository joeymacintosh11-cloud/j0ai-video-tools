import { useCallback, useEffect, useState } from "react";
import { getTrack, listTracks } from "./api/client.ts";
import { ErrorBanner } from "./components/ErrorBanner.tsx";
import { NewTrackPanel } from "./components/NewTrackPanel.tsx";
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

  const refreshAll = useCallback(() => {
    reloadTracks();
    reloadDetail();
  }, [reloadTracks, reloadDetail]);

  useWindowFocus(refreshAll);

  return (
    <div className="app">
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
          onClick={refreshAll}
        >
          Refresh
        </button>
      </header>

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
          />
        )}

        {detail.error ? (
          <div style={{ padding: 20 }}>
            <ErrorBanner error={detail.error} title="Could not load track" />
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
          <TrackDetail track={detail.data} onChanged={refreshAll} />
        ) : (
          <div className="placeholder">
            {tracks.loading || detail.loading
              ? "Loading…"
              : "Select a track"}
          </div>
        )}
      </div>
    </div>
  );
};
