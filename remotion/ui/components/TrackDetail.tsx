import { useState } from "react";
import type {
  ContentMetadataSettingsView,
  TrackDetailView,
} from "../../src/domain/api/views.ts";
import type { RenderPresetId } from "../../src/domain/video/renderPresets.ts";
import { publicAssetUrl } from "../api/assetUrl.ts";
import { deliveryFolderFor } from "../../src/domain/delivery/deliveryPaths.ts";
import { revealDelivery } from "../api/client.ts";
import { AssetChecklist } from "./AssetChecklist.tsx";
import { ContentPackagePanel } from "./ContentPackagePanel.tsx";
import { DeliverPanel } from "./DeliverPanel.tsx";
import { DestinationFixPlanPanel } from "./DestinationFixPlanPanel.tsx";
import { DestinationHealthPanel } from "./DestinationHealthPanel.tsx";
import { TrackDeliveryHistory } from "./DeliveryHistoryPanel.tsx";
import { DeliveryStatus } from "./DeliveryStatus.tsx";
import {
  ReleaseBundleBadge,
  ReleaseBundlePanel,
} from "./ReleaseBundlePanel.tsx";
import { ExportMissingPanel } from "./ExportMissingPanel.tsx";
import { ExportStatus } from "./ExportStatus.tsx";
import { AssetDropZone } from "./AssetDropZone.tsx";
import { MetadataForm } from "./MetadataForm.tsx";
import { PrepareActions } from "./PrepareActions.tsx";
import { TrackRecentRenderHistory } from "./RecentRenderHistory.tsx";
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
  /** Formats chosen in the toolbar; drives both preview and rendering. */
  readonly formats: readonly RenderPresetId[];
  /** The global content-metadata templates; null while still loading. */
  readonly contentMetadataSettings: ContentMetadataSettingsView | null;
  readonly onChanged: () => void;
  readonly onBatchStarted: (batchId: string) => void;
}> = ({ track, formats, contentMetadataSettings, onChanged, onBatchStarted }) => {
  const { metadata } = track;

  // Bumped only when an upload succeeds, so the cover's URL changes exactly
  // when the file behind it did.
  const [assetVersion, setAssetVersion] = useState(0);

  // Delivery is only shown once a destination exists; before that there is
  // nothing to say, and the Delivery settings panel is where that is set.
  const configuredDestination = track.exports.some(
    (output) => output.delivery.status !== "not_configured",
  );

  // What this track says it ships in, as opposed to what it has rendered. The
  // two are shown separately on purpose.
  const intendedLabels = track.exports
    .filter((output) => output.intended)
    .map((output) => output.label)
    .join(" · ");

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
        <MetadataForm
          track={track}
          contentMetadataSettings={contentMetadataSettings}
          onSaved={onChanged}
        />
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
          presetId={formats[0] ?? "youtube-16x9"}
          canPreview={track.metadataValid && track.coverPresent && track.audioPresent}
        />
      </section>

      <section className="section">
        <h3 className="section__title">Exports</h3>
        <p className="exports__intent">
          <span className="exports__intentlabel">Intended</span>
          {intendedLabels === "" ? "—" : intendedLabels}
          {track.exportPresets === null ? (
            <span className="muted">
              {" "}
              — not declared, so every format is assumed
            </span>
          ) : null}
        </p>
        <ExportStatus exports={track.exports} />
        <ExportMissingPanel
          label="Export missing"
          tracks={[track.slug]}
          formats={null}
          disabled={!track.validation.ok}
          onQueued={onBatchStarted}
          onChanged={onChanged}
        />
      </section>

      <section className="section">
        <h3 className="section__title">Content package</h3>
        <ContentPackagePanel
          track={track}
          globalTemplates={contentMetadataSettings?.templates ?? null}
          templatesProblem={contentMetadataSettings?.problem ?? null}
          onChanged={onChanged}
          onBatchStarted={onBatchStarted}
        />
      </section>

      {/* Delivery is its own section, below exports: a copy at the
          destination is downstream of a finished export, never a substitute
          for one. */}
      {configuredDestination ? (
        <section className="section">
          <h3 className="section__title">Delivery</h3>
          <p className="exports__intent">
            <span className="exports__intentlabel">Folder</span>
            {deliveryFolderFor(track.slug, track.deliveryFolder)}
            {track.deliveryFolder === null ? (
              <span className="muted"> — from the slug; set one in Track info</span>
            ) : null}
          </p>
          <DeliveryStatus exports={track.exports} />

          {/* What the folder says about itself, which is downstream of the
              deliveries above and can lag behind them. */}
          <p className="exports__intent">
            <span className="exports__intentlabel">Release bundle</span>
            <ReleaseBundleBadge status={track.releaseBundle} />
            <span className="muted">
              {track.releaseBundle.freshness === "not_configured"
                ? ""
                : `${track.releaseBundle.delivered} delivered · ` +
                  `${track.releaseBundle.outdated} outdated · ` +
                  `${track.releaseBundle.missing} missing`}
            </span>
          </p>

          {/* When this last went out, which the marks above cannot say: they
              describe the destination's current contents, not its past. */}
          <TrackDeliveryHistory slug={track.slug} />

          {/* Whether the destination still holds what these records say it
              should — a filesystem fact the marks above never check, since
              they describe recorded state, not what a sweep actually finds. */}
          <p className="exports__intent">
            <span className="exports__intentlabel">Destination health</span>
          </p>
          <DestinationHealthPanel label="Check this track" tracks={[track.slug]} />
          <DestinationFixPlanPanel tracks={[track.slug]} onApplied={onChanged} />

          <div className="form__actions">
            <DeliverPanel
              label="Deliver current exports"
              tracks={[track.slug]}
              disabled={!track.validation.ok}
              onChanged={onChanged}
            />
            <ReleaseBundlePanel
              label={
                track.releaseBundle.freshness === "missing"
                  ? "Generate release bundle"
                  : "Update release bundle"
              }
              tracks={[track.slug]}
              disabled={!track.validation.ok}
              onChanged={onChanged}
            />
            <button
              className="button button--quiet"
              type="button"
              onClick={() =>
                void revealDelivery(track.slug, formats[0]).catch(
                  () => undefined,
                )
              }
            >
              Reveal destination
            </button>
          </div>
        </section>
      ) : null}

      <section className="section">
        <h3 className="section__title">Render</h3>
        <RenderPanel
          track={track}
          formats={formats}
          onChanged={onChanged}
          onBatchStarted={onBatchStarted}
        />
      </section>

      {/* What the durable render journal remembers about this track, kept
          separate from the live state above: that section is what is
          rendering right now; this one is history and survives a server
          restart. Neither is derived from the other, and neither is derived
          from — or implies anything about — current package readiness. */}
      <section className="section">
        <h3 className="section__title">Recent render</h3>
        <TrackRecentRenderHistory slug={track.slug} />
      </section>

      <section className="section">
        <h3 className="section__title">Validation</h3>
        <ValidationNotes validation={track.validation} />
      </section>
    </article>
  );
};
