import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveContentPackage,
  type ContentPackageInput,
  type PackageExportEntry,
} from "../core/domain/content/contentPackage.ts";
import { derivePublishReadiness } from "../core/domain/content/publishReadiness.ts";

/**
 * "Is this track ready to publish?" — core/domain/content/publishReadiness.ts,
 * layered over an already-derived ContentPackageView
 * (core/domain/content/contentPackage.ts). Every test here builds a package
 * the same way tests/content-package.test.mts's own domain tests already do
 * (hand-built PackageExportEntry[] through the real deriveContentPackage,
 * never a hand-built ContentPackageView) — this module never invents its own
 * interpretation of readiness, so testing it against anything other than a
 * genuinely derived package would prove nothing about the real boundary.
 */

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

const byPlatform = (
  readiness: ReturnType<typeof derivePublishReadiness>,
  platformId: string,
) => readiness.platforms.find((p) => p.platformId === platformId)!;

/* ------------------------------------------------------------------ *
 * 1-5: the five headline states
 * ------------------------------------------------------------------ */

test("all selected ready, no destination configured: ready to publish", () => {
  const pkg = deriveContentPackage(baseInput());
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.status, "ready_to_publish");
  assert.equal(readiness.counts.ready, 3);
  assert.equal(readiness.primaryAction, null);
  assert.ok(readiness.platforms.every((p) => p.state === "ready"));
});

test("one missing: package is incomplete, primary action targets only that platform", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "missing" }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.status, "incomplete");
  assert.equal(readiness.counts.missing, 1);
  assert.equal(byPlatform(readiness, "youtube").state, "missing");
  assert.deepEqual(readiness.primaryAction, { kind: "build", label: "Build 1 missing asset" });
  assert.deepEqual(readiness.primaryActionTargets, ["youtube"]);
});

test("one stale: package is stale, primary action is re-render", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current" }),
        entry("vertical-9x16", { status: "stale", staleReasons: ["cover_changed"] }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.status, "stale");
  assert.equal(byPlatform(readiness, "reels").state, "stale");
  assert.deepEqual(readiness.primaryAction, { kind: "rerender", label: "Re-render 1 stale asset" });
});

test("one rendering: package is incomplete, primary action is to wait, not a button", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "rendering" }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.status, "incomplete");
  assert.equal(byPlatform(readiness, "youtube").state, "rendering");
  assert.equal(readiness.primaryAction?.kind, "wait");
});

test("blocked: an invalid track blocks every selected platform and dominates the status", () => {
  const pkg = deriveContentPackage(baseInput({ validationOk: false, metadata: null }));
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.status, "blocked");
  assert.ok(readiness.platforms.every((p) => p.state === "blocked"));
  assert.equal(readiness.primaryAction?.kind, "fix_validation");
});

/* ------------------------------------------------------------------ *
 * 6: unselected platform ignored
 * ------------------------------------------------------------------ */

test("an unselected platform is excluded from counts and never blocks readiness", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current", intended: true }),
        entry("vertical-9x16", { status: "missing", intended: false }),
        entry("square-1x1", { status: "current", intended: true }),
      ],
    }),
    { mode: "intent" },
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(byPlatform(readiness, "reels").state, "not_selected");
  assert.equal(readiness.counts.selected, 2);
  // Only two platforms are selected, both ready — the unselected, missing
  // third must never drag this down to "incomplete".
  assert.equal(readiness.status, "ready_to_publish");
});

/* ------------------------------------------------------------------ *
 * 7-9: package modes
 * ------------------------------------------------------------------ */

test("intent mode: only intended platforms are selected", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current", intended: true }),
        entry("vertical-9x16", { status: "current", intended: false }),
        entry("square-1x1", { status: "current", intended: false }),
      ],
    }),
    { mode: "intent" },
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.counts.selected, 1);
  assert.equal(byPlatform(readiness, "youtube").state, "ready");
});

test("full mode: every platform is selected regardless of declared intent", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current", intended: true }),
        entry("vertical-9x16", { status: "missing", intended: false }),
        entry("square-1x1", { status: "current", intended: false }),
      ],
    }),
    { mode: "full" },
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.counts.selected, 3);
  assert.equal(byPlatform(readiness, "reels").state, "missing");
  assert.equal(readiness.status, "incomplete");
});

test("explicit-platform (custom) mode: only the named platforms are selected", () => {
  const pkg = deriveContentPackage(baseInput(), { platforms: ["youtube", "reels"] });
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.counts.selected, 2);
  assert.equal(byPlatform(readiness, "instagram-square").state, "not_selected");
});

/* ------------------------------------------------------------------ *
 * 10: metadata resolution failure
 * ------------------------------------------------------------------ */

test("metadata resolution failure (null metadata) blocks every selected platform", () => {
  const pkg = deriveContentPackage(baseInput({ validationOk: false, metadata: null }));
  const readiness = derivePublishReadiness(pkg);

  assert.ok(readiness.platforms.every((p) => p.state === "blocked" || p.state === "not_selected"));
  const youtube = byPlatform(readiness, "youtube");
  assert.equal(youtube.platform.title, null);
});

/* ------------------------------------------------------------------ *
 * 11-13: delivery semantics
 * ------------------------------------------------------------------ */

test("destination configured and delivered: ready to publish", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", {
          status: "current",
          delivery: { status: "delivered", destinationRelativePath: "Probe Beat/probe-youtube-16x9.mp4", deliveredAt: "2026-09-20T10:00:00.000Z" },
        }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.status, "ready_to_publish");
  const youtube = byPlatform(readiness, "youtube");
  assert.equal(youtube.state, "ready");
  assert.equal(youtube.deliveryRequired, true);
  assert.equal(youtube.deliveredAt, "2026-09-20T10:00:00.000Z");
});

test("destination configured but not yet delivered: needs delivery, not ready to publish", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", {
          status: "current",
          delivery: { status: "pending", destinationRelativePath: null, reason: "never_delivered" },
        }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.status, "needs_delivery");
  const youtube = byPlatform(readiness, "youtube");
  assert.equal(youtube.state, "needs_delivery");
  assert.equal(youtube.deliveryNote, "Not delivered yet");
  assert.deepEqual(youtube.primaryAction, { kind: "deliver", label: "Deliver" });
  assert.deepEqual(readiness.primaryAction, { kind: "deliver", label: "Deliver 1 ready asset" });
});

test("no destination configured at all: locally ready is enough to be ready to publish", () => {
  const pkg = deriveContentPackage(baseInput()); // every export defaults to delivery.status "not_configured"
  const readiness = derivePublishReadiness(pkg);

  assert.ok(readiness.platforms.every((p) => p.deliveryRequired === false));
  assert.equal(readiness.status, "ready_to_publish");
});

test("a delivery that drifted (destination copy missing) is worded as review, not routine delivery", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", {
          status: "current",
          delivery: { status: "outdated", destinationRelativePath: "Probe Beat/probe-youtube-16x9.mp4", reason: "destination_missing" },
        }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  const readiness = derivePublishReadiness(pkg);
  const youtube = byPlatform(readiness, "youtube");

  assert.equal(youtube.state, "needs_delivery");
  assert.equal(youtube.deliveryNote, "Delivered file is missing");
  assert.deepEqual(youtube.primaryAction, { kind: "review_destination", label: "Review destination" });
  assert.deepEqual(readiness.primaryAction, { kind: "review_destination", label: "Review destination issue" });
});

/* ------------------------------------------------------------------ *
 * 14: mixed platform states
 * ------------------------------------------------------------------ */

test("mixed states: the most urgent one dominates the aggregate and the primary action", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "missing" }),
        entry("vertical-9x16", { status: "stale", staleReasons: ["audio_changed"] }),
        entry("square-1x1", {
          status: "current",
          delivery: { status: "pending", destinationRelativePath: null, reason: "never_delivered" },
        }),
      ],
    }),
  );
  const readiness = derivePublishReadiness(pkg);

  // missing outranks stale and needs_delivery.
  assert.equal(readiness.status, "incomplete");
  assert.equal(readiness.primaryAction?.kind, "build");
  assert.deepEqual(readiness.primaryActionTargets, ["youtube"]);
});

/* ------------------------------------------------------------------ *
 * 15: package aggregate counts
 * ------------------------------------------------------------------ */

test("package aggregate counts add up across every selected state", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "missing" }),
        entry("vertical-9x16", { status: "stale", staleReasons: ["audio_changed"] }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(readiness.counts.selected, 3);
  assert.equal(
    readiness.counts.ready +
      readiness.counts.needsDelivery +
      readiness.counts.missing +
      readiness.counts.stale +
      readiness.counts.rendering +
      readiness.counts.blocked,
    readiness.counts.selected,
  );
});

/* ------------------------------------------------------------------ *
 * 16: deterministic primary next action
 * ------------------------------------------------------------------ */

test("the primary action is fully deterministic — identical input always yields identical output", () => {
  const build = () =>
    derivePublishReadiness(
      deriveContentPackage(
        baseInput({
          exports: [
            entry("youtube-16x9", { status: "missing" }),
            entry("vertical-9x16", { status: "current" }),
            entry("square-1x1", { status: "current" }),
          ],
        }),
      ),
    );

  assert.deepEqual(build().primaryAction, build().primaryAction);
  assert.deepEqual(build().primaryActionTargets, build().primaryActionTargets);
});

/* ------------------------------------------------------------------ *
 * 17-18: render-journal/history context never overrides package truth
 *
 * derivePublishReadiness's own type signature takes only a
 * ContentPackageView — it has no parameter for journal/render-history data
 * at all, so "historical render state can never override current package
 * truth" (§40 of the milestone brief) is a structural fact here, not a
 * runtime check. These two tests exist to make that explicit rather than
 * merely implicit in the function signature.
 * ------------------------------------------------------------------ */

test("a completed historical render never masks a currently stale target", () => {
  // The journal may well say the most recent render "completed" — this
  // module never sees that fact at all; only the *current* export's own
  // freshness (staleReasons/status) reaches it, via ContentPackageView.
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "stale", staleReasons: ["cover_changed"] }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(byPlatform(readiness, "youtube").state, "stale");
  assert.equal(readiness.status, "stale");
});

test("an interrupted historical render never prevents a currently ready target from reading ready", () => {
  // Symmetric case: whatever the journal says about a *previous* attempt,
  // a target whose current export is genuinely current reads "ready" —
  // this module has no way to even ask what the journal says.
  const pkg = deriveContentPackage(baseInput());
  const readiness = derivePublishReadiness(pkg);

  assert.ok(readiness.platforms.every((p) => p.state === "ready"));
  assert.equal(readiness.status, "ready_to_publish");
});

/* ------------------------------------------------------------------ *
 * 19-20: copy-only edit vs. rendered-field edit
 *
 * Both scenarios are expressed the same way the underlying freshness system
 * already would: a copy-only (caption/template) change never touches
 * export.status, since it never touches the render fingerprint
 * (core/domain/tracks/exportManifest.ts fingerprints title/artist/key/bpm/
 * subtitle/cover/beat, never a metadata template); a rendered-field change
 * does. This module is not re-deriving that distinction — it is only
 * confirming it reads through correctly.
 * ------------------------------------------------------------------ */

test("a copy-only edit (e.g. a caption template) leaves the export current, and the platform ready", () => {
  const pkg = deriveContentPackage(
    baseInput({
      // A different contentMetadataOverrides is exactly a "copy-only" edit:
      // it changes rendered *text*, never the fingerprinted render inputs.
      contentMetadataOverrides: { reels: { captionTemplate: "New caption for {title}" } },
    }),
  );
  const readiness = derivePublishReadiness(pkg);

  assert.ok(readiness.platforms.every((p) => p.state === "ready"));
  assert.equal(readiness.status, "ready_to_publish");
  assert.match(byPlatform(readiness, "reels").platform.caption ?? "", /New caption/);
});

test("a rendered-field edit (e.g. the track's own title) is reflected as a stale export, not silently ready", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        // The title changed since this render's fingerprint was taken —
        // exactly what exportFreshness reports as a rendered-field change.
        entry("youtube-16x9", { status: "stale", staleReasons: ["metadata_changed"] }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  const readiness = derivePublishReadiness(pkg);

  assert.equal(byPlatform(readiness, "youtube").state, "stale");
  assert.equal(readiness.status, "stale");
});
