import type { TrackSummaryView } from "../../src/domain/api/views.ts";
import { StatusBadge } from "./StatusBadge.tsx";

/**
 * The track browser.
 *
 * A row's body still selects that track for the detail panel, exactly as
 * before. The checkbox is a separate, additive concern: it picks tracks for a
 * batch without changing what clicking a row does.
 */
export const TrackList: React.FC<{
  readonly tracks: readonly TrackSummaryView[];
  readonly selectedSlug: string | null;
  readonly onSelect: (slug: string) => void;
  readonly checked: readonly string[];
  readonly onToggleChecked: (slug: string) => void;
}> = ({ tracks, selectedSlug, onSelect, checked, onToggleChecked }) => (
  <nav className="tracklist" aria-label="Tracks">
    <div className="tracklist__head">
      <span>Tracks</span>
      <span>
        {checked.length > 0 ? `${checked.length} of ${tracks.length}` : tracks.length}
      </span>
    </div>

    {tracks.length === 0 ? (
      <p className="muted" style={{ padding: "16px" }}>
        No tracks yet. Create one with <code>npm run new-track</code>.
      </p>
    ) : (
      tracks.map((track) => (
        <div
          key={track.slug}
          className={
            track.slug === selectedSlug
              ? "tracklist__item tracklist__item--selected"
              : "tracklist__item"
          }
        >
          <label
            className="tracklist__check"
            title={`Include ${track.title ?? track.slug} in a batch`}
          >
            <input
              type="checkbox"
              checked={checked.includes(track.slug)}
              onChange={() => onToggleChecked(track.slug)}
            />
          </label>

          <button
            type="button"
            className="tracklist__body"
            aria-current={track.slug === selectedSlug}
            onClick={() => onSelect(track.slug)}
          >
            <span className="tracklist__name">{track.title ?? track.slug}</span>
            <span className="tracklist__slug">{track.slug}</span>
            <span className="tracklist__meta">
              <StatusBadge status={track.status} />
              {track.renderPresent ? (
                <span className="tracklist__slug">rendered</span>
              ) : null}
            </span>
          </button>
        </div>
      ))
    )}
  </nav>
);
