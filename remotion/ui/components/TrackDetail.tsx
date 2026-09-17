import { useState } from "react";
import type { TrackDetailView } from "../../src/domain/api/views.ts";
import { publicAssetUrl } from "../api/assetUrl.ts";
import { AssetChecklist } from "./AssetChecklist.tsx";
import { AssetDropZone } from "./AssetDropZone.tsx";
import { MetadataForm } from "./MetadataForm.tsx";
import { PrepareActions } from "./PrepareActions.tsx";
import { RenderPanel } from "./RenderPanel.tsx";
import { StatusBadge } from "./StatusBadge.tsx";
import { TrackPreview } from "./TrackPreview.tsx";
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

export const TrackDetail: React.FC<{
  readonly track: TrackDetailView;
  readonly onChanged: () => void;
}> = ({ track, onChanged }) => {
  const { metadata } = track;

  // Bumped only when an upload succeeds, so the cover's URL changes exactly
  // when the file behind it did.
  const [assetVersion, setAssetVersion] = useState(0);

  const onUploaded = () => {
    setAssetVersion((previous) => previous + 1);
    onChanged();
  };

  return (
    <article className="detail">
      <header className="detail__head">
        {track.coverPresent ? (
          <img
            className="detail__cover"
            src={publicAssetUrl(track.assets.cover, assetVersion)}
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
            <Stat label="Key" value={metadata?.key ? metadata.key : null} />
            <Stat
              label="BPM"
              value={
                typeof metadata?.bpm === "number" ? String(metadata.bpm) : null
              }
            />
          </div>
        </div>
      </header>

      <section className="section">
        <h3 className="section__title">Track info</h3>
        <MetadataForm track={track} onSaved={onChanged} />
      </section>

      <section className="section">
        <h3 className="section__title">Files</h3>
        <div className="dropzones">
          <AssetDropZone
            slug={track.slug}
            kind="cover"
            present={track.coverPresent}
            onUploaded={onUploaded}
          />
          <AssetDropZone
            slug={track.slug}
            kind="beat"
            present={track.audioPresent}
            onUploaded={onUploaded}
          />
        </div>
        <AssetChecklist track={track} />
      </section>

      <section className="section">
        <h3 className="section__title">Prepare</h3>
        <PrepareActions track={track} onChanged={onChanged} />
      </section>

      <section className="section">
        <h3 className="section__title">Preview</h3>
        <TrackPreview
          slug={track.slug}
          canPreview={track.metadataValid && track.coverPresent && track.audioPresent}
        />
      </section>

      <section className="section">
        <h3 className="section__title">Render</h3>
        <RenderPanel track={track} onChanged={onChanged} />
      </section>

      <section className="section">
        <h3 className="section__title">Validation</h3>
        <ValidationNotes validation={track.validation} />
      </section>
    </article>
  );
};
