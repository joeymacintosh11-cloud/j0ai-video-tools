import type { TrackDetailView } from "../../src/domain/api/views.ts";
import { publicAssetUrl } from "../api/assetUrl.ts";
import { AssetChecklist } from "./AssetChecklist.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { ValidationNotes } from "./ValidationNotes.tsx";

const Stat: React.FC<{
  readonly label: string;
  readonly value: string | null;
}> = ({ label, value }) => (
  <div className="stat">
    <div className="stat__label">{label}</div>
    <div className={value ? "stat__value" : "stat__value stat__value--empty"}>
      {value ?? "—"}
    </div>
  </div>
);

export const TrackDetail: React.FC<{ readonly track: TrackDetailView }> = ({
  track,
}) => {
  const { metadata } = track;

  return (
    <article className="detail">
      <header className="detail__head">
        {track.coverPresent ? (
          <img
            className="detail__cover"
            src={publicAssetUrl(track.assets.cover)}
            alt={`${track.title ?? track.slug} cover art`}
          />
        ) : (
          <div className="detail__cover detail__cover--empty">No cover</div>
        )}

        <div>
          <div className="detail__artist">{metadata?.artist ?? "—"}</div>
          <h2 className="detail__title">{track.title ?? track.slug}</h2>
          <div className="detail__slug">{track.assets.metadata}</div>
          <div className="detail__headmeta">
            <StatusBadge status={track.status} />
          </div>
        </div>
      </header>

      <section className="section">
        <h3 className="section__title">Track info</h3>
        <div className="stats">
          <Stat label="Key" value={metadata?.key ? metadata.key : null} />
          <Stat
            label="BPM"
            value={
              typeof metadata?.bpm === "number" ? String(metadata.bpm) : null
            }
          />
        </div>
        <p style={{ marginTop: 12 }}>
          {metadata?.subtitle ?? <span className="muted">No subtitle</span>}
        </p>
      </section>

      <section className="section">
        <h3 className="section__title">Files</h3>
        <AssetChecklist track={track} />
      </section>

      <section className="section">
        <h3 className="section__title">Validation</h3>
        <ValidationNotes validation={track.validation} />
      </section>
    </article>
  );
};
