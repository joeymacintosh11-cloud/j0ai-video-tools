import { useMemo, useState } from "react";
import {
  deriveContentPackage,
  formatPackageCopyForClipboard,
  formatPlatformCopyForClipboard,
  type ContentPackageInput,
  type ContentPackageMode,
  type ContentPackageStatus,
} from "../../src/domain/content/contentPackage.ts";
import {
  derivePublishReadiness,
  type PublishPackageStatus,
  type PublishPlatformEntry,
} from "../../src/domain/content/publishReadiness.ts";
import { initialCustomPlatforms } from "../../src/domain/content/packageScope.ts";
import { PLATFORM_LIST, type PlatformId } from "../../src/domain/content/platformProfiles.ts";
import { STALE_REASON_LABELS } from "../../src/domain/video/exportFreshness.ts";
import { canonicalPresetOrder } from "../../src/domain/video/renderPresets.ts";
import type {
  PartialMetadataTemplates,
  TrackDetailView,
} from "../../src/domain/api/views.ts";
import { copyToClipboard } from "../api/clipboard.ts";
import { revealTrackOutput } from "../api/client.ts";
import { DeliverPanel } from "./DeliverPanel.tsx";
import { ExportMissingPanel } from "./ExportMissingPanel.tsx";
import { PlatformPicker } from "./PlatformPicker.tsx";

const ALL_PLATFORM_IDS: readonly PlatformId[] = PLATFORM_LIST.map((platform) => platform.id);

/**
 * "For this beat: which platform assets are ready, which need attention, and
 * what should I do next?" — the Ready-to-Publish workflow.
 *
 * Entirely a view over state the app already computes: `deriveContentPackage`
 * (export coverage, freshness, queue state, delivery state) and
 * `derivePublishReadiness` (whether a current render, plus delivery when a
 * destination is configured, means a platform is actually done) are both
 * pure functions of this track's own detail view — no extra fetch, no new
 * readiness authority. Building and delivering are not reimplemented here:
 * "Package actions" below hands off to the same ExportMissingPanel and
 * DeliverPanel the rest of the app already uses, scoped to this package's
 * own selected platforms.
 *
 * "Ready to publish" never means this tool published anything — there is no
 * social API integration in this product. It means the operator has
 * everything they need to publish manually: a current video and its
 * resolved copy, delivered wherever a destination is configured for it.
 */

const STATUS_LABELS: Record<ContentPackageStatus, string> = {
  complete: "Complete",
  incomplete: "Incomplete",
  stale: "Stale",
  blocked: "Blocked",
  not_configured: "No platforms selected",
};

/**
 * One line per package-scope mode, shown just under the mode buttons —
 * added because a first-time operator switching to Custom has no other cue
 * that it is a view choice, not a save: nothing here mutates the track's own
 * saved export intent (§ handoff, "saved intent vs. current scope").
 */
const MODE_HINT: Record<ContentPackageMode, string> = {
  intent: "Uses this track's saved export choices.",
  full: "Every supported platform, regardless of what's saved.",
  custom: "Choose platforms for this view only — doesn't change what's saved.",
};

export const PackageStatusBadge: React.FC<{
  readonly status: ContentPackageStatus;
}> = ({ status }) => (
  <span className={`pkgbadge pkgbadge--${status}`}>{STATUS_LABELS[status]}</span>
);

/* ------------------------------------------------------------------ *
 * The package-level headline ("READY TO PUBLISH", "2 items need attention", ...)
 * ------------------------------------------------------------------ */

const PUBLISH_HEADLINE: Record<PublishPackageStatus, string> = {
  ready_to_publish: "Ready to publish",
  needs_delivery: "Needs delivery",
  incomplete: "Needs attention",
  stale: "Needs attention",
  blocked: "Blocked",
  not_configured: "No platforms selected",
};

const packageHeadline = (
  status: PublishPackageStatus,
  counts: { readonly missing: number; readonly stale: number; readonly needsDelivery: number; readonly rendering: number; readonly selected: number },
): string => {
  if (status === "not_configured" || status === "blocked" || status === "ready_to_publish") {
    return PUBLISH_HEADLINE[status];
  }

  const attention = counts.missing + counts.stale + counts.needsDelivery;
  if (attention === 0 && counts.rendering > 0) {
    return `Rendering ${counts.rendering} of ${counts.selected}`;
  }
  return `${attention} item${attention === 1 ? " needs" : "s need"} attention`;
};

const PublishStatusBanner: React.FC<{
  readonly status: PublishPackageStatus;
  readonly counts: { readonly missing: number; readonly stale: number; readonly needsDelivery: number; readonly rendering: number; readonly selected: number; readonly ready: number };
}> = ({ status, counts }) => (
  <div className={`publishbanner publishbanner--${status}`} role="status">
    <span className="publishbanner__headline">{packageHeadline(status, counts)}</span>
    {status !== "not_configured" ? (
      <span className="publishbanner__detail">
        {counts.selected} platform{counts.selected === 1 ? "" : "s"} selected
        {status === "ready_to_publish"
          ? " · all metadata resolved"
          : ` · ${counts.ready}/${counts.selected} ready`}
      </span>
    ) : null}
  </div>
);

/* ------------------------------------------------------------------ *
 * Copy actions
 * ------------------------------------------------------------------ */

type CopyState = "idle" | "copied" | "failed";

/**
 * One clipboard button. Never claims success before
 * navigator.clipboard.writeText's own promise resolves, and says so plainly
 * when it does not — no fake success toast (§8 of the milestone brief).
 */
const CopyButton: React.FC<{
  readonly label: string;
  readonly text: string;
  readonly className?: string;
}> = ({ label, text, className }) => {
  const [state, setState] = useState<CopyState>("idle");

  const copy = async () => {
    const ok = await copyToClipboard(text);
    setState(ok ? "copied" : "failed");
    setTimeout(() => setState("idle"), 2000);
  };

  return (
    <button
      type="button"
      className={className ?? "button button--quiet"}
      onClick={() => void copy()}
      aria-label={label}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Couldn't copy — try again" : label}
    </button>
  );
};

/* ------------------------------------------------------------------ *
 * One platform's card
 * ------------------------------------------------------------------ */

const STATE_MARK: Record<PublishPlatformEntry["state"], { glyph: string; note: string }> = {
  ready: { glyph: "✓", note: "Ready" },
  needs_delivery: { glyph: "!", note: "Needs delivery" },
  missing: { glyph: "—", note: "Missing" },
  stale: { glyph: "!", note: "Stale" },
  rendering: { glyph: "●", note: "Rendering" },
  blocked: { glyph: "!", note: "Blocked" },
  not_selected: { glyph: "◦", note: "Not selected" },
};

/**
 * One resolved field, with its plain character count — advisory only, never
 * a hard limit (§31/§32 of the milestone brief: this repository has no
 * documented per-platform character guideline to reuse, so none is
 * invented or presented as a real limit; the count itself is just a fact).
 */
const CopyField: React.FC<{
  readonly label: string;
  readonly value: string;
  readonly multiline?: boolean;
}> = ({ label, value, multiline = false }) => (
  <div className="publishcard__field">
    <span className="exports__intentlabel">
      {label}
      <span className="publishcard__charcount">
        {value.length} character{value.length === 1 ? "" : "s"}
      </span>
    </span>
    {multiline ? (
      <pre className="contentpackage__description">{value}</pre>
    ) : (
      <p>{value}</p>
    )}
  </div>
);

/** A checklist line: a small tick/mark plus a label, never color alone (§41: status is not communicated by color only). */
const CheckRow: React.FC<{
  readonly ok: boolean | null;
  readonly label: string;
}> = ({ ok, label }) => (
  <li className={`publishcard__check publishcard__check--${ok === null ? "na" : ok ? "yes" : "no"}`}>
    <span aria-hidden="true" className="publishcard__checkmark">
      {ok === null ? "–" : ok ? "✓" : "✗"}
    </span>
    <span>{label}</span>
  </li>
);

const PlatformCard: React.FC<{
  readonly entry: PublishPlatformEntry;
  readonly slug: string;
  readonly onRevealed: (error: string | null) => void;
}> = ({ entry, slug, onRevealed }) => {
  const { platform, state } = entry;
  const mark = STATE_MARK[state];
  const copyText = formatPlatformCopyForClipboard(platform);
  // "queued"/"rendering"/"invalid" are not a file on disk yet — only
  // "current" and "stale" mean a real, revealable export already exists.
  const hasVideo = platform.renderStatus === "current" || platform.renderStatus === "stale";
  // Strictly "current", not merely "some file exists": a stale export is a
  // real file on disk (hasVideo, above) but must never read as "ready" here
  // — that would contradict the card's own "Metadata changed"/stale note
  // right next to it.
  const videoCurrent = platform.readiness === "ready";

  const reveal = async () => {
    try {
      await revealTrackOutput(slug, platform.presetId);
      onRevealed(null);
    } catch (cause) {
      onRevealed(cause instanceof Error ? cause.message : "Could not reveal the file.");
    }
  };

  if (state === "not_selected") {
    return (
      <li className="publishcard publishcard--unselected">
        <div className="publishcard__head">
          <span className="publishcard__label">{platform.label}</span>
          <span className="publishcard__note muted">Not selected</span>
        </div>
      </li>
    );
  }

  return (
    <li className={`publishcard publishcard--${state}`}>
      <div className="publishcard__head">
        <span className="publishcard__mark" aria-hidden="true">
          {mark.glyph}
        </span>
        <span className="publishcard__label">{platform.label}</span>
        <span className="publishcard__note">
          {state === "stale" && platform.staleReasons.length > 0
            ? platform.staleReasons.map((reason) => STALE_REASON_LABELS[reason]).join("; ")
            : state === "needs_delivery" && entry.deliveryNote !== null
              ? entry.deliveryNote
              : mark.note}
        </span>
      </div>

      <ul className="publishcard__checklist">
        <CheckRow ok={videoCurrent} label="Video ready" />
        <CheckRow
          ok={platform.title !== null || platform.caption !== null}
          label="Metadata ready"
        />
        <CheckRow
          ok={entry.deliveryRequired ? entry.state !== "needs_delivery" : null}
          label={entry.deliveryRequired ? "Delivered" : "Delivery not configured"}
        />
      </ul>

      {platform.blockers.length > 0 ? (
        <p className="note note--error publishcard__blocker">{platform.blockers.join(" ")}</p>
      ) : null}

      {copyText !== "" ? (
        <details className="publishcard__preview">
          <summary>Preview copy</summary>
          {platform.title !== null ? (
            <CopyField label="Title" value={platform.title} />
          ) : null}
          {platform.description !== null ? (
            <CopyField label="Description" value={platform.description} multiline />
          ) : null}
          {platform.keywords !== null && platform.keywords.length > 0 ? (
            <CopyField label="Keywords" value={platform.keywords.join(", ")} />
          ) : null}
          {platform.caption !== null ? (
            <CopyField label="Caption" value={platform.caption} multiline />
          ) : null}
          {platform.hashtags !== null && platform.hashtags.length > 0 ? (
            <CopyField label="Hashtags" value={platform.hashtags.join(" ")} />
          ) : null}
        </details>
      ) : null}

      {entry.primaryAction !== null && state !== "rendering" ? (
        <p className="publishcard__hint muted">Next: {entry.primaryAction.label} (see Package actions below)</p>
      ) : null}

      {copyText !== "" ? (
        <div className="publishcard__actions">
          <CopyButton label={`Copy ${platform.label} copy`} text={copyText} />
          {hasVideo ? (
            <button
              type="button"
              className="button button--quiet"
              onClick={() => void reveal()}
              aria-label={`Reveal ${platform.label} video file`}
            >
              Reveal video
            </button>
          ) : null}
        </div>
      ) : hasVideo ? (
        <div className="publishcard__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={() => void reveal()}
            aria-label={`Reveal ${platform.label} video file`}
          >
            Reveal video
          </button>
        </div>
      ) : null}
    </li>
  );
};

/* ------------------------------------------------------------------ *
 * The panel
 * ------------------------------------------------------------------ */

export const ContentPackagePanel: React.FC<{
  readonly track: TrackDetailView;
  /** The global content-metadata templates; null while still loading or unconfigured. */
  readonly globalTemplates: PartialMetadataTemplates | null;
  readonly templatesProblem: string | null;
  readonly onChanged: () => void;
  readonly onBatchStarted: (batchId: string) => void;
}> = ({ track, globalTemplates, templatesProblem, onChanged, onBatchStarted }) => {
  // "mode" is view/workflow scope only — which platforms the Content Package
  // below inspects right now. It never writes the track's own persisted
  // export intent (that only ever changes through the metadata form's own
  // "save intent" path); switching Intent → Full → Custom is pure client
  // state, so it can never render, deliver, or mutate anything by itself.
  const [uiMode, setUiMode] = useState<ContentPackageMode>("intent");
  // null = Custom has not been touched this session yet, so its first
  // checked set is still owed an initialization (see switchToCustom below).
  // Once set, it survives switching to Intent/Full and back, so a selection
  // already made is never silently discarded.
  const [customPlatforms, setCustomPlatforms] = useState<readonly PlatformId[] | null>(null);
  const [revealError, setRevealError] = useState<string | null>(null);

  const packageInput: ContentPackageInput = useMemo(
    () => ({
      slug: track.slug,
      title: track.title,
      validationOk: track.validation.ok,
      metadata: track.metadata,
      contentMetadataOverrides: track.metadata?.contentMetadataOverrides,
      exports: track.exports,
    }),
    [track],
  );

  // Read via the real "intent" derivation rather than re-reading
  // track.exports' own `intended` flags here, so Custom's Intent-seeded
  // selection can never drift from what Intent mode itself would show —
  // one selection rule, not two.
  const intentPlatformIds = useMemo(
    () =>
      deriveContentPackage(packageInput, { mode: "intent", globalTemplates, templatesProblem })
        .platforms.filter((platform) => platform.selected)
        .map((platform) => platform.platformId),
    [packageInput, globalTemplates, templatesProblem],
  );

  const effectiveCustomPlatforms = customPlatforms ?? intentPlatformIds;

  const pkg = useMemo(
    () =>
      deriveContentPackage(
        packageInput,
        uiMode === "custom"
          ? { platforms: effectiveCustomPlatforms, globalTemplates, templatesProblem }
          : { mode: uiMode, globalTemplates, templatesProblem },
      ),
    [packageInput, uiMode, effectiveCustomPlatforms, globalTemplates, templatesProblem],
  );

  const readiness = useMemo(() => derivePublishReadiness(pkg), [pkg]);

  const switchToCustom = () => {
    if (customPlatforms === null) {
      setCustomPlatforms(
        initialCustomPlatforms(uiMode === "full" ? "full" : "intent", intentPlatformIds, ALL_PLATFORM_IDS),
      );
    }
    setUiMode("custom");
  };

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

  // Goes straight to the metadata overrides editor itself, not just the
  // Track info section it lives in — that editor is a collapsed <details>
  // by default, so without opening it here "Edit copy" would land the
  // operator one extra click away from the fields they actually asked for.
  const editCopy = () => {
    const overrides = document.getElementById("content-metadata-overrides");
    if (overrides instanceof HTMLDetailsElement) {
      overrides.open = true;
      overrides.scrollIntoView({ behavior: "smooth", block: "start" });
      return;
    }
    document.getElementById("track-info")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const allCopyText = formatPackageCopyForClipboard(pkg.platforms);

  return (
    <div className="contentpackage">
      {pkg.templatesProblem ? (
        <p className="note note--warning" role="status">
          <span className="note__message">{pkg.templatesProblem}</span>
        </p>
      ) : null}

      {revealError ? (
        <p className="note note--error" role="alert">
          <span className="note__message">{revealError}</span>
        </p>
      ) : null}

      <PublishStatusBanner status={readiness.status} counts={readiness.counts} />

      <div className="contentpackage__summary">
        <PackageStatusBadge status={pkg.packageStatus} />
        <span className="exportmissing__counts">
          {pkg.counts.ready}/{pkg.counts.selected} ready
          {pkg.counts.missing > 0 ? ` · ${pkg.counts.missing} missing` : ""}
          {pkg.counts.stale > 0 ? ` · ${pkg.counts.stale} stale` : ""}
          {pkg.counts.rendering > 0 ? ` · ${pkg.counts.rendering} rendering` : ""}
          {readiness.counts.needsDelivery > 0 ? ` · ${readiness.counts.needsDelivery} needs delivery` : ""}
        </span>

        <div className="contentpackage__modes" role="group" aria-label="Package scope">
          <button
            type="button"
            className={`button button--quiet${uiMode === "intent" ? " button--active" : ""}`}
            aria-pressed={uiMode === "intent"}
            onClick={() => setUiMode("intent")}
          >
            Intended formats
          </button>
          <button
            type="button"
            className={`button button--quiet${uiMode === "full" ? " button--active" : ""}`}
            aria-pressed={uiMode === "full"}
            onClick={() => setUiMode("full")}
          >
            Full package ({ALL_PLATFORM_IDS.length})
          </button>
          <button
            type="button"
            className={`button button--quiet${uiMode === "custom" ? " button--active" : ""}`}
            aria-pressed={uiMode === "custom"}
            onClick={switchToCustom}
          >
            Custom
          </button>
        </div>
      </div>

      <p className="muted contentpackage__modehint">{MODE_HINT[uiMode]}</p>

      {uiMode === "custom" ? (
        <PlatformPicker
          selected={effectiveCustomPlatforms}
          onChange={setCustomPlatforms}
          label="Custom platforms"
          className="contentpackage__platformpicker"
        />
      ) : null}

      <ul className="publishcard__list">
        {readiness.platforms.map((entry) => (
          <PlatformCard
            key={entry.platformId}
            entry={entry}
            slug={track.slug}
            onRevealed={setRevealError}
          />
        ))}
      </ul>

      <div className="contentpackage__packageactions">
        <p className="exports__intentlabel contentpackage__actionslabel">Package actions</p>
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

        <div className="form__actions">
          <button
            type="button"
            className="button button--quiet"
            onClick={editCopy}
          >
            Edit copy
          </button>
          {allCopyText !== "" ? (
            <CopyButton label="Copy all metadata" text={allCopyText} />
          ) : null}
        </div>
      </div>
    </div>
  );
};
