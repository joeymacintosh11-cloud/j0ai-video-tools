import type { TrackSummaryView } from "../../src/domain/api/views.ts";
import { StatusBadge } from "./StatusBadge.tsx";

export const TrackList: React.FC<{
  readonly tracks: readonly TrackSummaryView[];
  readonly selectedSlug: string | null;
  readonly onSelect: (slug: string) => void;
}> = ({ tracks, selectedSlug, onSelect }) => (
  <nav className="tracklist" aria-label="Tracks">
    <div className="tracklist__head">
      <span>Tracks</span>
      <span>{tracks.length}</span>
    </div>

    {tracks.length === 0 ? (
      <p className="muted" style={{ padding: "16px" }}>
        No tracks yet. Create one with <code>npm run new-track</code>.
      </p>
    ) : (
      tracks.map((track) => (
        <button
          key={track.slug}
          type="button"
          className={
            track.slug === selectedSlug
              ? "tracklist__item tracklist__item--selected"
              : "tracklist__item"
          }
          aria-current={track.slug === selectedSlug}
          onClick={() => onSelect(track.slug)}
        >
          <div className="tracklist__name">{track.title ?? track.slug}</div>
          <div className="tracklist__slug">{track.slug}</div>
          <div className="tracklist__meta">
            <StatusBadge status={track.status} />
            {track.renderPresent ? (
              <span className="tracklist__slug">rendered</span>
            ) : null}
          </div>
        </button>
      ))
    )}
  </nav>
);
