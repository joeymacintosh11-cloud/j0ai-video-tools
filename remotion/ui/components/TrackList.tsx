import { useMemo } from "react";
import type {
  DestinationHealthView,
  TrackSummaryView,
} from "../../src/domain/api/views.ts";
import { deriveContentPackage } from "../../src/domain/content/contentPackage.ts";
import { PackageStatusBadge } from "./ContentPackagePanel.tsx";
import { DeliverySummary } from "./DeliveryStatus.tsx";
import { DestinationHealthBadge } from "./DestinationHealthPanel.tsx";
import { ReleaseBundleBadge } from "./ReleaseBundlePanel.tsx";
import { ExportStatus } from "./ExportStatus.tsx";
import { StatusBadge } from "./StatusBadge.tsx";

/**
 * Package readiness for a catalogue row.
 *
 * Derived from the same `exports` the row's other marks already read — no
 * extra fetch per row, and no full metadata subject (TrackSummaryView does
 * not carry one), which the readiness computation does not need anyway.
 */
const packageStatusFor = (track: TrackSummaryView) =>
  deriveContentPackage(
    {
      slug: track.slug,
      title: track.title,
      validationOk: track.metadataValid,
      metadata: null,
      exports: track.exports,
    },
    { mode: "intent" },
  ).packageStatus;

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
  /** Ticks every track currently listed here — always this whole list, never a hidden superset. */
  readonly onSelectAll: () => void;
  readonly onClearSelection: () => void;
  /**
   * The last catalogue-wide destination scan, or null if none has been run
   * this session. Never fetched here, and never implied to be current — a scan
   * is always an explicit action, so a badge only ever reflects whatever that
   * last click found.
   */
  readonly health?: DestinationHealthView | null;
}> = ({
  tracks,
  selectedSlug,
  onSelect,
  checked,
  onToggleChecked,
  onSelectAll,
  onClearSelection,
  health = null,
}) => {
  const packageStatuses = useMemo(() => {
    const byslug = new Map<string, ReturnType<typeof packageStatusFor>>();
    for (const track of tracks) byslug.set(track.slug, packageStatusFor(track));
    return byslug;
  }, [tracks]);

  return (
  <nav className="tracklist" aria-label="Tracks">
    <div className="tracklist__head">
      <span>Tracks</span>
      <span className="tracklist__headactions">
        <span>
          {checked.length > 0 ? `${checked.length} of ${tracks.length}` : tracks.length}
        </span>
        {tracks.length > 0 ? (
          <button
            type="button"
            className="button button--quiet button--tiny"
            title={`Select all ${tracks.length} listed track${tracks.length === 1 ? "" : "s"}`}
            onClick={checked.length === tracks.length ? onClearSelection : onSelectAll}
          >
            {checked.length === tracks.length ? "Select none" : "Select all"}
          </button>
        ) : null}
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
              <ExportStatus exports={track.exports} compact />
              <DeliverySummary exports={track.exports} />
              {/* Not shown for "not_configured" — a track with nothing
                  selected has no package to speak of yet. */}
              {packageStatuses.get(track.slug) === "not_configured" ? null : (
                <PackageStatusBadge status={packageStatuses.get(track.slug) ?? "not_configured"} />
              )}
              {/* Only once a destination exists; before that a bundle has
                  nowhere to live and the badge would be noise. */}
              {track.releaseBundle.freshness === "not_configured" ? null : (
                <ReleaseBundleBadge status={track.releaseBundle} />
              )}
              {/* Only shown once a scan has actually named this track — no
                  badge at all reads honestly as "not scanned", rather than
                  implying a live answer this list never fetches on its own. */}
              {(() => {
                const found = health?.tracks.find((entry) => entry.slug === track.slug);
                if (found === undefined) return null;
                return (
                  <DestinationHealthBadge
                    status={found.findings.length > 0 ? "drift" : "healthy"}
                    title={
                      found.findings.length > 0
                        ? `${found.findings.length} finding${found.findings.length === 1 ? "" : "s"} at ${health?.scannedAt}`
                        : `No drift found at ${health?.scannedAt}`
                    }
                  />
                );
              })()}
            </span>
          </button>
        </div>
      ))
    )}
  </nav>
  );
};
