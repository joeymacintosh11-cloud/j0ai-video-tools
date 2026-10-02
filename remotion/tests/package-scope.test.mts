import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveContentPackage,
  formatPackageCopyForClipboard,
  type ContentPackageInput,
  type PackageExportEntry,
} from "../core/domain/content/contentPackage.ts";
import { derivePublishReadiness } from "../core/domain/content/publishReadiness.ts";
import { initialCustomPlatforms } from "../core/domain/content/packageScope.ts";
import { PLATFORM_LIST, type PlatformId } from "../core/domain/content/platformProfiles.ts";

/**
 * The Single-Track Custom Platforms Picker: making the Content Package's
 * existing explicit-platform ("custom") mode fully usable from the
 * single-track UI (ui/components/ContentPackagePanel.tsx,
 * ui/components/PlatformPicker.tsx).
 *
 * This file covers only what is genuinely new for this milestone:
 *   - initialCustomPlatforms (core/domain/content/packageScope.ts), the pure
 *     rule for what Custom starts checked with the first time an operator
 *     switches into it.
 *   - that a Custom scope excludes/includes exactly the platforms it names
 *     for readiness, counts, the primary action and copy-all — reusing
 *     deriveContentPackage's and derivePublishReadiness's own machinery,
 *     never a second interpretation of readiness.
 *
 * deriveContentPackage's own explicit-platform mode (custom scope selection,
 * dedup/ordering via canonicalPlatformOrder, the empty-selection state) was
 * already implemented and tested by the previous milestone
 * (tests/content-package.test.mts: "an explicit platform list overrides
 * mode entirely", "no platform selected reports not_configured...",
 * "formatPackageCopyForClipboard ... excludes unselected ones") and is not
 * duplicated here.
 */

const ALL_IDS: readonly PlatformId[] = PLATFORM_LIST.map((p) => p.id);

const entry = (
  presetId: PackageExportEntry["presetId"],
  overrides: Partial<PackageExportEntry> = {},
): PackageExportEntry => ({
  presetId,
  status: "missing",
  staleReasons: [],
  intended: true,
  delivery: { status: "not_configured", destinationRelativePath: null },
  ...overrides,
});

const baseInput = (
  overrides: Partial<ContentPackageInput> = {},
): ContentPackageInput => ({
  slug: "probe",
  title: "Probe Beat",
  validationOk: true,
  metadata: {
    title: "Probe Beat",
    artist: "Toshi",
    key: "F Minor",
    bpm: 100,
    subtitle: "Boom bap soul, trap bounce and latin heat.",
  },
  exports: [
    entry("youtube-16x9", { status: "current" }),
    entry("vertical-9x16", { status: "current" }),
    entry("square-1x1", { status: "current" }),
  ],
  ...overrides,
});

/* ------------------------------------------------------------------ *
 * initialCustomPlatforms: what Custom starts checked with
 * ------------------------------------------------------------------ */

test("intent -> custom initializes from the currently resolved intent set", () => {
  const intentIds: readonly PlatformId[] = ["youtube", "reels"];
  assert.deepEqual(initialCustomPlatforms("intent", intentIds, ALL_IDS), ["youtube", "reels"]);
});

test("full -> custom initializes from every supported platform", () => {
  const intentIds: readonly PlatformId[] = ["youtube"];
  assert.deepEqual(initialCustomPlatforms("full", intentIds, ALL_IDS), ALL_IDS);
});

test("intent -> custom initializes empty when intent itself selects nothing", () => {
  assert.deepEqual(initialCustomPlatforms("intent", [], ALL_IDS), []);
});

/* ------------------------------------------------------------------ *
 * Unselected siblings never contribute to readiness, counts or the
 * primary action — only the platforms actually in scope do.
 * ------------------------------------------------------------------ */

test("an unselected stale sibling does not block Ready to Publish", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current" }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "stale", staleReasons: ["metadata_changed"] }),
      ],
    }),
    { platforms: ["youtube", "reels"] },
  );
  const readiness = derivePublishReadiness(pkg);
  assert.equal(readiness.status, "ready_to_publish");
  assert.equal(readiness.counts.selected, 2);
  assert.equal(readiness.counts.stale, 0);

  const instagram = readiness.platforms.find((p) => p.platformId === "instagram-square")!;
  assert.equal(instagram.state, "not_selected");
});

test("a selected stale target does block Ready to Publish", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current" }),
        entry("vertical-9x16", { status: "stale", staleReasons: ["audio_changed"] }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
    { platforms: ["youtube", "reels"] },
  );
  const readiness = derivePublishReadiness(pkg);
  assert.equal(readiness.status, "stale");
  assert.equal(readiness.primaryAction?.kind, "rerender");
  assert.deepEqual(readiness.primaryActionTargets, ["reels"]);
});

test("a selected missing target drives the primary action; an unselected missing sibling does not", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "missing" }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "missing" }),
      ],
    }),
    { platforms: ["youtube", "reels"] },
  );
  const readiness = derivePublishReadiness(pkg);
  assert.equal(readiness.primaryAction?.kind, "build");
  assert.deepEqual(readiness.primaryActionTargets, ["youtube"]);
  assert.equal(readiness.counts.missing, 1);
});

test("delivery requirement applies only inside scope: a configured-but-undelivered sibling outside scope is invisible to readiness", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current" }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", {
          status: "current",
          delivery: { status: "pending", reason: "never_delivered", destinationRelativePath: "probe-square.mp4" },
        }),
      ],
    }),
    { platforms: ["youtube", "reels"] },
  );
  const readiness = derivePublishReadiness(pkg);
  assert.equal(readiness.status, "ready_to_publish");
  assert.equal(readiness.counts.needsDelivery, 0);
});

test("custom counts reflect only the selected platforms, never the full supported set", () => {
  const pkg = deriveContentPackage(baseInput(), { platforms: ["youtube", "reels"] });
  const readiness = derivePublishReadiness(pkg);
  assert.equal(readiness.counts.selected, 2);
  assert.equal(pkg.counts.selected, 2);
});

test("copy-all respects custom scope: only named platforms appear", () => {
  const pkg = deriveContentPackage(baseInput(), { platforms: ["youtube", "instagram-square"] });
  const text = formatPackageCopyForClipboard(pkg.platforms);
  assert.match(text, /YOUTUBE/);
  assert.match(text, /INSTAGRAM SQUARE/);
  assert.doesNotMatch(text, /REELS/);
});

test("duplicate platform ids in a custom selection are deduped, not double-counted", () => {
  const pkg = deriveContentPackage(baseInput(), {
    platforms: ["youtube", "youtube", "reels"] as readonly PlatformId[],
  });
  assert.equal(pkg.counts.selected, 2);
});

test("an empty custom selection is reported as not_configured, with no primary action, and never falls back to intent", () => {
  const pkg = deriveContentPackage(baseInput(), { platforms: [] });
  const readiness = derivePublishReadiness(pkg);
  assert.equal(pkg.packageStatus, "not_configured");
  assert.equal(readiness.status, "not_configured");
  assert.equal(readiness.primaryAction, null);
  assert.equal(readiness.counts.selected, 0);
  // Every platform reads "not_selected", not silently "ready" from intent.
  for (const platform of readiness.platforms) {
    assert.equal(platform.state, "not_selected");
  }
});

test("an unselected platform's underlying render state remains visible (not hidden or faked) for the UI's subdued card", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current" }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "stale", staleReasons: ["cover_changed"] }),
      ],
    }),
    { platforms: ["youtube", "reels"] },
  );
  const instagram = pkg.platforms.find((p) => p.platformId === "instagram-square")!;
  assert.equal(instagram.selected, false);
  assert.equal(instagram.readiness, "not_selected");
  // The real underlying facts are still there for diagnostics, not erased:
  assert.equal(instagram.renderStatus, "stale");
  assert.deepEqual(instagram.staleReasons, ["cover_changed"]);
});

test("scope selection never mutates the caller's export list (no export-intent, no fingerprint side effect)", () => {
  const exports = [
    entry("youtube-16x9", { status: "current", intended: true }),
    entry("vertical-9x16", { status: "current", intended: false }),
    entry("square-1x1", { status: "stale", staleReasons: ["preset_changed"], intended: false }),
  ];
  const frozen = JSON.parse(JSON.stringify(exports));

  deriveContentPackage(baseInput({ exports }), { platforms: ["reels", "instagram-square"] });
  deriveContentPackage(baseInput({ exports }), { mode: "full" });
  deriveContentPackage(baseInput({ exports }), { mode: "intent" });

  assert.deepEqual(exports, frozen);
});

test("switching scope is deterministic: the same platform set always derives the same readiness, regardless of how mode arrived there", () => {
  const input = baseInput();
  const viaCustom = derivePublishReadiness(deriveContentPackage(input, { platforms: ALL_IDS }));
  const viaFull = derivePublishReadiness(deriveContentPackage(input, { mode: "full" }));
  assert.deepEqual(viaCustom.status, viaFull.status);
  assert.deepEqual(viaCustom.counts, viaFull.counts);
  assert.deepEqual(
    viaCustom.platforms.map((p) => [p.platformId, p.state]),
    viaFull.platforms.map((p) => [p.platformId, p.state]),
  );
});
