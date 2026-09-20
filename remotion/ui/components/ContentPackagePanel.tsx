import { useMemo, useState } from "react";
import {
  deriveContentPackage,
  type ContentPackagePlatformEntry,
  type ContentPackageStatus,
} from "../../src/domain/content/contentPackage.ts";
import { STALE_REASON_LABELS } from "../../src/domain/video/exportFreshness.ts";
import { canonicalPresetOrder } from "../../src/domain/video/renderPresets.ts";
import type {
  PartialMetadataTemplates,
  TrackDetailView,
} from "../../src/domain/api/views.ts";
import { DeliverPanel } from "./DeliverPanel.tsx";
import { ExportMissingPanel } from "./ExportMissingPanel.tsx";

/**
 * "For this beat, what content do I need for YouTube, Reels/TikTok and
 * Instagram, what is ready, what is stale or missing, and how do I generate
 * the complete package?"
 *
 * Entirely a view: `deriveContentPackage` is pure and takes exactly the
 * `exports` this track's detail view already carries (coverage, freshness,
 * queue state and delivery state), so this panel needs no fetch of its own
 * and can never disagree with the Exports/Delivery sections above it — it is
 * the same facts, read differently. Building and delivering are not
 * reimplemented here: they hand off to the same ExportMissingPanel and
 * DeliverPanel the Exports/Delivery sections already use, scoped to this
 * package's own platforms.
 */

const STATUS_LABELS: Record<ContentPackageStatus, string> = {
  complete: "Complete",
  incomplete: "Incomplete",
  stale: "Stale",
  blocked: "Blocked",
  not_configured: "No platforms selected",
};

const READINESS_MARK: Record<
  ContentPackagePlatformEntry["readiness"],
  { glyph: string; note: string }
> = {
  ready: { glyph: "✓", note: "Ready" },
  missing: { glyph: "—", note: "Missing" },
  stale: { glyph: "!", note: "Stale" },
  rendering: { glyph: "●", note: "Rendering" },
  blocked: { glyph: "!", note: "Blocked" },
  not_selected: { glyph: "◦", note: "Not part of this package" },
};

export const PackageStatusBadge: React.FC<{
  readonly status: ContentPackageStatus;
}> = ({ status }) => (
  <span className={`pkgbadge pkgbadge--${status}`}>{STATUS_LABELS[status]}</span>
);

const PlatformRow: React.FC<{ readonly platform: ContentPackagePlatformEntry }> = ({
  platform,
}) => {
  const [expanded, setExpanded] = useState(false);
  const mark = READINESS_MARK[platform.readiness];
  const hasMetadata =
    platform.title !== null ||
    platform.description !== null ||
    platform.caption !== null ||
    (platform.hashtags?.length ?? 0) > 0;

  return (
    <li
      className={`contentpackage__row contentpackage__row--${platform.readiness}${platform.selected ? "" : " contentpackage__row--unselected"}`}
    >
      <div className="contentpackage__head">
        <span className="contentpackage__mark" aria-hidden="true">
          {mark.glyph}
        </span>
        <span className="contentpackage__label">{platform.label}</span>
        <span className="contentpackage__note">
          {platform.readiness === "stale" && platform.staleReasons.length > 0
            ? platform.staleReasons
                .map((reason) => STALE_REASON_LABELS[reason])
                .join("; ")
            : mark.note}
        </span>
        {hasMetadata ? (
          <button
            type="button"
            className="button button--quiet contentpackage__toggle"
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "Hide metadata" : "Preview metadata"}
          </button>
        ) : null}
      </div>

      <div className="contentpackage__filename">{platform.outputFilename}</div>

      {platform.blockers.length > 0 ? (
        <p className="note note--error contentpackage__blocker">
          {platform.blockers.join(" ")}
        </p>
      ) : null}

      {expanded && hasMetadata ? (
        <div className="contentpackage__metadata">
          {platform.title !== null ? (
            <div>
              <span className="exports__intentlabel">Title</span>
              <p>{platform.title}</p>
            </div>
          ) : null}
          {platform.description !== null ? (
            <div>
              <span className="exports__intentlabel">Description</span>
              <pre className="contentpackage__description">
                {platform.description}
              </pre>
            </div>
          ) : null}
          {platform.keywords !== null && platform.keywords.length > 0 ? (
            <div>
              <span className="exports__intentlabel">Keywords</span>
              <p>{platform.keywords.join(", ")}</p>
            </div>
          ) : null}
          {platform.caption !== null ? (
            <div>
              <span className="exports__intentlabel">Caption</span>
              <p>{platform.caption}</p>
            </div>
          ) : null}
          {platform.hashtags !== null && platform.hashtags.length > 0 ? (
            <div>
              <span className="exports__intentlabel">Hashtags</span>
              <p>{platform.hashtags.join(" ")}</p>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
};

export const ContentPackagePanel: React.FC<{
  readonly track: TrackDetailView;
  /** The global content-metadata templates; null while still loading or unconfigured. */
  readonly globalTemplates: PartialMetadataTemplates | null;
  readonly onChanged: () => void;
  readonly onBatchStarted: (batchId: string) => void;
}> = ({ track, globalTemplates, onChanged, onBatchStarted }) => {
  const [mode, setMode] = useState<"intent" | "full">("intent");

  const pkg = useMemo(
    () =>
      deriveContentPackage(
        {
          slug: track.slug,
          title: track.title,
          validationOk: track.validation.ok,
          metadata: track.metadata,
          contentMetadataOverrides: track.metadata?.contentMetadataOverrides,
          exports: track.exports,
        },
        { mode, globalTemplates },
      ),
    [track, mode, globalTemplates],
  );

  const selectedPresetIds = useMemo(
    () =>
      canonicalPresetOrder(
        pkg.platforms.filter((platform) => platform.selected).map((platform) => platform.presetId),
      ),
    [pkg],
  );

  const configuredDestination = pkg.platforms.some(
    (platform) => platform.deliveryStatus !== "not_configured",
  );

  return (
    <div className="contentpackage">
      <div className="contentpackage__summary">
        <PackageStatusBadge status={pkg.packageStatus} />
        <span className="exportmissing__counts">
          {pkg.counts.ready}/{pkg.counts.selected} ready
          {pkg.counts.missing > 0 ? ` · ${pkg.counts.missing} missing` : ""}
          {pkg.counts.stale > 0 ? ` · ${pkg.counts.stale} stale` : ""}
          {pkg.counts.rendering > 0 ? ` · ${pkg.counts.rendering} rendering` : ""}
        </span>

        <div className="contentpackage__modes">
          <button
            type="button"
            className={`button button--quiet${mode === "intent" ? " button--active" : ""}`}
            onClick={() => setMode("intent")}
          >
            Intended formats
          </button>
          <button
            type="button"
            className={`button button--quiet${mode === "full" ? " button--active" : ""}`}
            onClick={() => setMode("full")}
          >
            Full package (3)
          </button>
        </div>
      </div>

      <ul className="contentpackage__list">
        {pkg.platforms.map((platform) => (
          <PlatformRow key={platform.platformId} platform={platform} />
        ))}
      </ul>

      <ExportMissingPanel
        label="Build package"
        tracks={[track.slug]}
        formats={selectedPresetIds}
        disabled={!track.validation.ok || selectedPresetIds.length === 0}
        onQueued={onBatchStarted}
        onChanged={onChanged}
      />

      {configuredDestination ? (
        <DeliverPanel
          label="Deliver package"
          tracks={[track.slug]}
          presets={selectedPresetIds}
          disabled={!track.validation.ok || selectedPresetIds.length === 0}
          onChanged={onChanged}
        />
      ) : null}
    </div>
  );
};
