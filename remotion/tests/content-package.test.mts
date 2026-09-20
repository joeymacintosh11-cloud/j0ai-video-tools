import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { fixture } from "./fixtures.mts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { metadataRevision } from "../services/tracks/metadataRevision.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { parseTrackMetadata } from "../src/domain/tracks/metadata.ts";
import { toTrackDetailView } from "../server/views/trackView.ts";
import {
  TrackError,
} from "../src/domain/tracks/errors.ts";
import {
  deriveContentPackage,
  type ContentPackageInput,
  type ContentPackageOptions,
  type PackageExportEntry,
} from "../src/domain/content/contentPackage.ts";
import {
  assertPlatformId,
  canonicalPlatformOrder,
  platformFilename,
  platformsForPreset,
} from "../src/domain/content/platformProfiles.ts";
import { buildPlatformMetadata } from "../src/domain/content/platformMetadata.ts";

/**
 * The content package: a platform-facing view derived from the same export
 * coverage, queue state and delivery state the rest of the app already
 * computes — never a second source of truth (§ handoff doc, "Toshi Content
 * Package Workflow").
 *
 * Most of this file is domain-level and needs no filesystem at all: readiness
 * derivation and metadata templates are pure functions of hand-built inputs.
 * A handful of tests go end to end through a real fixture, `publishExport`
 * (the same helper export-freshness.test.mts uses to certify a manifest
 * without forking an actual Remotion render) and `toTrackDetailView`, to prove
 * the wiring a unit test cannot: that the server's own view shape feeds this
 * module correctly.
 */

/* ------------------------------------------------------------------ *
 * Domain: readiness derivation
 * ------------------------------------------------------------------ */

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

test("all three platforms ready produces a complete package", () => {
  const pkg = deriveContentPackage(baseInput());
  assert.equal(pkg.packageStatus, "complete");
  assert.equal(pkg.counts.selected, 3);
  assert.equal(pkg.counts.ready, 3);
  assert.ok(pkg.platforms.every((p) => p.readiness === "ready"));
});

test("all three platforms missing produces an incomplete package", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9"),
        entry("vertical-9x16"),
        entry("square-1x1"),
      ],
    }),
  );
  assert.equal(pkg.packageStatus, "incomplete");
  assert.equal(pkg.counts.missing, 3);
  assert.equal(pkg.counts.ready, 0);
});

test("one missing platform keeps the other two ready — a partial package is not failed", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current" }),
        entry("vertical-9x16"),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  assert.equal(pkg.packageStatus, "incomplete");
  assert.equal(pkg.counts.ready, 2);
  assert.equal(pkg.counts.missing, 1);
  const youtube = pkg.platforms.find((p) => p.platformId === "youtube")!;
  const reels = pkg.platforms.find((p) => p.platformId === "reels")!;
  assert.equal(youtube.readiness, "ready");
  assert.equal(reels.readiness, "missing");
});

test("one stale platform, nothing missing or in flight, produces a stale package", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current" }),
        entry("vertical-9x16", {
          status: "stale",
          staleReasons: ["cover_changed"],
        }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  assert.equal(pkg.packageStatus, "stale");
  assert.equal(pkg.counts.stale, 1);
  const reels = pkg.platforms.find((p) => p.platformId === "reels")!;
  assert.equal(reels.readiness, "stale");
  assert.deepEqual(reels.staleReasons, ["cover_changed"]);
});

test("stale outranks nothing, but missing/rendering outrank stale", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "stale", staleReasons: ["audio_changed"] }),
        entry("vertical-9x16"), // missing
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  // A missing platform is a stronger claim than "merely stale" — you cannot
  // even redeliver what was never rendered.
  assert.equal(pkg.packageStatus, "incomplete");
});

test("a queued or active render reads as rendering, not missing", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "queued" }),
        entry("vertical-9x16", { status: "rendering" }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  assert.equal(pkg.counts.rendering, 2);
  assert.equal(pkg.counts.missing, 0);
  assert.equal(pkg.packageStatus, "incomplete");
  const youtube = pkg.platforms.find((p) => p.platformId === "youtube")!;
  assert.equal(youtube.readiness, "rendering");
  assert.equal(youtube.renderStatus, "queued");
});

test("a blocked track marks every selected platform blocked and clears its metadata preview", () => {
  const pkg = deriveContentPackage(
    baseInput({
      validationOk: false,
      metadata: null,
      exports: [
        entry("youtube-16x9", { status: "current" }), // even a "current" file cannot save it
        entry("vertical-9x16"),
        entry("square-1x1"),
      ],
    }),
  );
  assert.equal(pkg.packageStatus, "blocked");
  assert.ok(pkg.platforms.every((p) => p.readiness === "blocked"));
  assert.ok(pkg.platforms.every((p) => p.title === null && p.caption === null));
  const youtube = pkg.platforms.find((p) => p.platformId === "youtube")!;
  assert.ok(youtube.blockers.length > 0);
});

test("intent mode selects only the platforms the track's own exportPresets declare", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current", intended: true }),
        entry("vertical-9x16", { intended: false }),
        entry("square-1x1", { intended: false }),
      ],
    }),
  );
  assert.equal(pkg.mode, "intent");
  const selected = pkg.platforms.filter((p) => p.selected).map((p) => p.platformId);
  assert.deepEqual(selected, ["youtube"]);
  assert.equal(
    pkg.platforms.find((p) => p.platformId === "reels")!.readiness,
    "not_selected",
  );
  // Complete: the one selected platform is ready, and unselected platforms
  // never drag the package down.
  assert.equal(pkg.packageStatus, "complete");
});

test("full mode selects every platform regardless of declared intent", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", { status: "current", intended: true }),
        entry("vertical-9x16", { intended: false }),
        entry("square-1x1", { intended: false }),
      ],
    }),
    { mode: "full" },
  );
  assert.equal(pkg.mode, "full");
  assert.equal(pkg.counts.selected, 3);
});

test("an explicit platform list overrides mode entirely", () => {
  const pkg = deriveContentPackage(baseInput(), { mode: "full", platforms: ["reels"] });
  assert.equal(pkg.mode, "custom");
  const selected = pkg.platforms.filter((p) => p.selected).map((p) => p.platformId);
  assert.deepEqual(selected, ["reels"]);
});

test("no platform selected reports not_configured, not blocked or complete", () => {
  const pkg = deriveContentPackage(baseInput(), { platforms: [] });
  assert.equal(pkg.counts.selected, 0);
  assert.equal(pkg.packageStatus, "not_configured");
});

test("changing only track metadata never changes readiness — text and render state are independent axes", () => {
  const withSubtitle = deriveContentPackage(baseInput());
  const withoutSubtitle = deriveContentPackage(
    baseInput({ metadata: { title: "Probe Beat", artist: "Toshi", key: "F Minor", bpm: 100 } }),
  );
  assert.equal(withSubtitle.packageStatus, withoutSubtitle.packageStatus);
  assert.deepEqual(
    withSubtitle.platforms.map((p) => p.readiness),
    withoutSubtitle.platforms.map((p) => p.readiness),
  );
  const youtube = withSubtitle.platforms.find((p) => p.platformId === "youtube")!;
  const youtubeNoSubtitle = withoutSubtitle.platforms.find((p) => p.platformId === "youtube")!;
  assert.notEqual(youtube.title, youtubeNoSubtitle.title);
});

test("the generated timestamp uses an injectable clock", () => {
  const pkg = deriveContentPackage(baseInput(), { now: () => "2026-09-20T00:00:00.000Z" });
  assert.equal(pkg.generatedAt, "2026-09-20T00:00:00.000Z");
});

test("output filenames are platform aliases, distinct from canonical/delivery paths", () => {
  const pkg = deriveContentPackage(baseInput());
  const byId = new Map(pkg.platforms.map((p) => [p.platformId, p]));
  assert.equal(byId.get("youtube")!.outputFilename, "probe-youtube.mp4");
  assert.equal(byId.get("reels")!.outputFilename, "probe-reels.mp4");
  assert.equal(byId.get("instagram-square")!.outputFilename, "probe-square.mp4");
});

test("available actions follow readiness: render, rerender, or deliver", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9"), // missing
        entry("vertical-9x16", { status: "stale", staleReasons: ["preset_changed"] }),
        entry("square-1x1", {
          status: "current",
          delivery: { status: "pending", destinationRelativePath: null },
        }),
      ],
    }),
  );
  const byId = new Map(pkg.platforms.map((p) => [p.platformId, p]));
  assert.deepEqual(byId.get("youtube")!.actions, ["render"]);
  assert.deepEqual(byId.get("reels")!.actions, ["rerender"]);
  assert.deepEqual(byId.get("instagram-square")!.actions, ["deliver"]);
});

test("a delivered, current platform offers no further action", () => {
  const pkg = deriveContentPackage(
    baseInput({
      exports: [
        entry("youtube-16x9", {
          status: "current",
          delivery: { status: "delivered", destinationRelativePath: "Probe Beat/probe-youtube-16x9.mp4" },
        }),
        entry("vertical-9x16", { status: "current" }),
        entry("square-1x1", { status: "current" }),
      ],
    }),
  );
  const youtube = pkg.platforms.find((p) => p.platformId === "youtube")!;
  assert.deepEqual(youtube.actions, []);
  assert.equal(youtube.destinationRelativePath, "Probe Beat/probe-youtube-16x9.mp4");
});

/* ------------------------------------------------------------------ *
 * Domain: platform profiles
 * ------------------------------------------------------------------ */

test("assertPlatformId accepts known ids and rejects everything else", () => {
  assert.equal(assertPlatformId("youtube"), "youtube");
  assert.throws(() => assertPlatformId("tiktok-only"), (error: unknown) => {
    assert.ok(error instanceof TrackError);
    assert.equal(error.code, "INVALID_PLATFORM");
    return true;
  });
});

test("canonicalPlatformOrder dedupes and orders by the canonical list", () => {
  assert.deepEqual(
    canonicalPlatformOrder(["reels", "youtube", "reels", "instagram-square"]),
    ["youtube", "reels", "instagram-square"],
  );
});

test("platformsForPreset resolves the platform built on a given preset", () => {
  assert.deepEqual(platformsForPreset("youtube-16x9"), ["youtube"]);
  assert.deepEqual(platformsForPreset("vertical-9x16"), ["reels"]);
  assert.deepEqual(platformsForPreset("square-1x1"), ["instagram-square"]);
});

/* ------------------------------------------------------------------ *
 * Domain: platform metadata templates
 * ------------------------------------------------------------------ */

const subject = {
  title: "Ghetto Geek",
  artist: "Toshi",
  key: "F Minor",
  bpm: 100,
  subtitle: "Boom bap soul, trap bounce and latin heat.",
};

test("YouTube metadata is deterministic: title, description and keywords", () => {
  const a = buildPlatformMetadata("ghetto-geek", "youtube", subject);
  const b = buildPlatformMetadata("ghetto-geek", "youtube", subject);
  assert.deepEqual(a, b);
  assert.equal(a.title, "Ghetto Geek | Boom bap soul, trap bounce and latin heat. | Toshi");
  assert.match(a.description!, /^Ghetto Geek by Toshi\.$/m);
  assert.match(a.description!, /^Key: F Minor$/m);
  assert.match(a.description!, /^BPM: 100$/m);
  assert.ok(a.keywords!.includes("toshi"));
  assert.ok(a.keywords!.includes("100bpm"));
  assert.equal(a.keywords!.filter((k) => k === "toshi").length, 1, "the artist tag and the fixed tag never duplicate");
  assert.equal(a.caption, null);
  assert.equal(a.filename, "ghetto-geek-youtube.mp4");
});

test("Reels/TikTok metadata is a deterministic caption, no title or description", () => {
  const meta = buildPlatformMetadata("ghetto-geek", "reels", subject);
  assert.equal(meta.title, null);
  assert.equal(meta.description, null);
  assert.equal(meta.keywords, null);
  assert.equal(
    meta.caption,
    "Ghetto Geek — Toshi (F Minor, 100 BPM) — Boom bap soul, trap bounce and latin heat.",
  );
  assert.equal(meta.filename, "ghetto-geek-reels.mp4");
});

test("Instagram Square metadata is a deterministic caption, filename says 'square'", () => {
  const meta = buildPlatformMetadata("ghetto-geek", "instagram-square", subject);
  assert.equal(
    meta.caption,
    "Ghetto Geek — Toshi (F Minor, 100 BPM) — Boom bap soul, trap bounce and latin heat.",
  );
  assert.equal(meta.filename, "ghetto-geek-square.mp4");
});

test("a track with no subtitle falls back to a key/BPM tagline, not an empty one", () => {
  const noSubtitle = { title: "Ghetto Geek", artist: "Toshi", key: "F Minor", bpm: 100 };
  const youtube = buildPlatformMetadata("ghetto-geek", "youtube", noSubtitle);
  assert.equal(youtube.title, "Ghetto Geek | F Minor · 100 BPM | Toshi");
  const reels = buildPlatformMetadata("ghetto-geek", "reels", noSubtitle);
  assert.equal(reels.caption, "Ghetto Geek — Toshi (F Minor, 100 BPM)");
});

test("platformFilename never collides with a canonical render or delivery path", () => {
  assert.equal(platformFilename("ghetto-geek", "youtube"), "ghetto-geek-youtube.mp4");
  // Distinct from the canonical out/<slug>/<preset>.mp4 ...
  assert.notEqual(platformFilename("ghetto-geek", "youtube"), "youtube-16x9.mp4");
  // ... and from delivery's <slug>-<preset-id>.mp4.
  assert.notEqual(platformFilename("ghetto-geek", "youtube"), "ghetto-geek-youtube-16x9.mp4");
});

/* ------------------------------------------------------------------ *
 * End to end: a real fixture, published exports, the server's own view
 * ------------------------------------------------------------------ */

const setup = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const f = await fixture(t, extra);
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));
  const props = buildTrackProps({
    slug: f.slug,
    metadata: parseTrackMetadata(JSON.parse(await readFile(f.metadata, "utf8")), "fixture"),
    analysisAvailable: true,
  });
  const publish = (presetId: "youtube-16x9" | "vertical-9x16" | "square-1x1") =>
    publishExport(f.slug, presetId, fingerprintInputs(props, presetId), async (file) => {
      await writeFile(file, "successful video");
    });
  const packageView = async (
    options: {
      mode?: "intent" | "full";
      globalTemplates?: ContentPackageOptions["globalTemplates"];
    } = {},
  ) => {
    const inspection = await inspectTrack(f.slug);
    const detail = toTrackDetailView(inspection, new Map(), null);
    return deriveContentPackage(
      {
        slug: detail.slug,
        title: detail.title,
        validationOk: detail.validation.ok,
        metadata: detail.metadata,
        contentMetadataOverrides: detail.metadata?.contentMetadataOverrides,
        exports: detail.exports,
      },
      options,
    );
  };
  return { ...f, props, publish, packageView };
};

test("a track with every format published reads as a complete package, end to end", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9", "vertical-9x16", "square-1x1"] });
  await f.publish("youtube-16x9");
  await f.publish("vertical-9x16");
  await f.publish("square-1x1");
  const pkg = await f.packageView();
  assert.equal(pkg.packageStatus, "complete");
  assert.equal(pkg.counts.ready, 3);
});

test("a partially published track reads as a partial package, never as fully failed", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9", "vertical-9x16", "square-1x1"] });
  await f.publish("youtube-16x9");
  const pkg = await f.packageView();
  assert.equal(pkg.packageStatus, "incomplete");
  assert.equal(pkg.counts.ready, 1);
  assert.equal(pkg.counts.missing, 2);
});

test("declared export intent narrows the package by default, without a mode override", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  await f.publish("youtube-16x9");
  const pkg = await f.packageView();
  assert.equal(pkg.counts.selected, 1);
  assert.equal(pkg.packageStatus, "complete");

  const full = await f.packageView({ mode: "full" });
  assert.equal(full.counts.selected, 3);
  assert.equal(full.packageStatus, "incomplete");
});

test("an invalid metadata.json blocks the package rather than reporting stray missing formats", async (t) => {
  const f = await setup(t);
  await writeFile(f.metadata, "not json");
  const pkg = await f.packageView();
  assert.equal(pkg.packageStatus, "blocked");
  assert.ok(pkg.platforms.every((p) => !p.selected || p.readiness === "blocked"));
});

test("a re-render that changes inputs makes a previously ready platform stale, not silently current", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  await f.publish("youtube-16x9");
  assert.equal((await f.packageView()).packageStatus, "complete");

  await writeFile(f.beat, "different audio entirely");
  const pkg = await f.packageView();
  assert.equal(pkg.packageStatus, "stale");
  const youtube = pkg.platforms.find((p) => p.platformId === "youtube")!;
  assert.deepEqual(youtube.staleReasons, ["audio_changed"]);
});

/* ------------------------------------------------------------------ *
 * Editable metadata templates, end to end through a real track: the
 * precedence chain, render-freshness separation, and on-disk validation.
 * ------------------------------------------------------------------ */

test("a track's own contentMetadataOverrides wins over a global template, end to end", async (t) => {
  const f = await setup(t, {
    exportPresets: ["youtube-16x9"],
    contentMetadataOverrides: { youtube: { titleTemplate: "{title} [Exclusive]" } },
  });
  const pkg = await f.packageView({
    globalTemplates: { youtube: { titleTemplate: "{title} - {artist}" } },
  });
  const youtube = pkg.platforms.find((p) => p.platformId === "youtube")!;
  assert.equal(youtube.title, "Fixture [Exclusive]");
});

test("a partial per-track override leaves every other field on the global/built-in chain", async (t) => {
  const f = await setup(t, {
    exportPresets: ["youtube-16x9", "vertical-9x16"],
    contentMetadataOverrides: { youtube: { titleTemplate: "{title} [Exclusive]" } },
  });
  const pkg = await f.packageView({
    globalTemplates: { youtube: { descriptionTemplate: "GLOBAL DESC" }, reels: { captionTemplate: "GLOBAL CAPTION" } },
  });
  const youtube = pkg.platforms.find((p) => p.platformId === "youtube")!;
  const reels = pkg.platforms.find((p) => p.platformId === "reels")!;
  assert.equal(youtube.title, "Fixture [Exclusive]"); // track override
  assert.equal(youtube.description, "GLOBAL DESC"); // falls to global, untouched by the title-only override
  assert.equal(reels.caption, "GLOBAL CAPTION"); // an entirely different platform, unaffected
});

test("clearing a track's contentMetadataOverrides (metadata PATCH null) restores inherited copy", async (t) => {
  const f = await setup(t, {
    exportPresets: ["youtube-16x9"],
    contentMetadataOverrides: { youtube: { titleTemplate: "{title} [Exclusive]" } },
  });
  const before = await f.packageView({ globalTemplates: { youtube: { titleTemplate: "GLOBAL" } } });
  assert.equal(before.platforms.find((p) => p.platformId === "youtube")!.title, "Fixture [Exclusive]");

  await updateTrackMetadata(f.slug, { contentMetadataOverrides: null });
  const after = await f.packageView({ globalTemplates: { youtube: { titleTemplate: "GLOBAL" } } });
  assert.equal(after.platforms.find((p) => p.platformId === "youtube")!.title, "GLOBAL");
});

test("an existing metadata.json with no contentMetadataOverrides field is still fully valid", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const inspection = await inspectTrack(f.slug);
  assert.equal(inspection.validation.ok, true);
  assert.equal(inspection.metadata?.contentMetadataOverrides, undefined);
});

test("a track that declares an unknown placeholder in its overrides is reported invalid, and the file is not written", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  await assert.rejects(
    () => updateTrackMetadata(f.slug, { contentMetadataOverrides: { youtube: { titleTemplate: "{mood}" } } }),
    (error: unknown) => {
      assert.ok(error instanceof TrackError);
      assert.equal(error.code, "TEMPLATE_INVALID");
      return true;
    },
  );
  const onDisk = JSON.parse(await readFile(f.metadata, "utf8"));
  assert.equal(onDisk.contentMetadataOverrides, undefined);
});

test("saving contentMetadataOverrides through the metadata PATCH round-trips through the same optimistic-concurrency path", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const first = await updateTrackMetadata(f.slug, {
    contentMetadataOverrides: { youtube: { titleTemplate: "{title} v1" } },
  });
  const revision = metadataRevision(await readFile(f.metadata, "utf8"));

  // A stale revision is refused, exactly like every other metadata field.
  await assert.rejects(
    () =>
      updateTrackMetadata(
        f.slug,
        { contentMetadataOverrides: { youtube: { titleTemplate: "{title} v2" } } },
        "stale-revision",
      ),
    (error: unknown) => {
      assert.ok(error instanceof TrackError);
      assert.equal(error.code, "METADATA_CONFLICT");
      return true;
    },
  );

  const second = await updateTrackMetadata(
    f.slug,
    { contentMetadataOverrides: { youtube: { titleTemplate: "{title} v2" } } },
    revision,
  );
  assert.deepEqual(first.metadata.contentMetadataOverrides, { youtube: { titleTemplate: "{title} v1" } });
  assert.deepEqual(second.metadata.contentMetadataOverrides, { youtube: { titleTemplate: "{title} v2" } });
});

test("editing contentMetadataOverrides never changes the render fingerprint — text templates cannot make a video stale", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  await f.publish("youtube-16x9");
  assert.equal((await f.packageView()).packageStatus, "complete");

  await updateTrackMetadata(f.slug, {
    contentMetadataOverrides: { youtube: { descriptionTemplate: "Totally different description {title}" } },
  });

  const pkg = await f.packageView();
  assert.equal(pkg.packageStatus, "complete", "a metadata-template-only change must not trigger a re-render");
  const youtube = pkg.platforms.find((p) => p.platformId === "youtube")!;
  assert.equal(youtube.readiness, "ready");
  assert.deepEqual(youtube.staleReasons, []);
});

test("editing a field that is actually rendered into the video (title) still makes it stale, exactly as before", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  await f.publish("youtube-16x9");
  assert.equal((await f.packageView()).packageStatus, "complete");

  await updateTrackMetadata(f.slug, { title: "A brand new title" });

  const pkg = await f.packageView();
  assert.equal(pkg.packageStatus, "stale");
  const youtube = pkg.platforms.find((p) => p.platformId === "youtube")!;
  assert.deepEqual(youtube.staleReasons, ["metadata_changed"]);
});

test("package readiness and the catalogue-style status are unaffected by copy-only global templates", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  await f.publish("youtube-16x9");
  const before = await f.packageView();
  const after = await f.packageView({ globalTemplates: { youtube: { titleTemplate: "{title} completely different" } } });
  assert.equal(before.packageStatus, after.packageStatus);
  assert.deepEqual(
    before.platforms.map((p) => p.readiness),
    after.platforms.map((p) => p.readiness),
  );
  assert.notEqual(
    before.platforms.find((p) => p.platformId === "youtube")!.title,
    after.platforms.find((p) => p.platformId === "youtube")!.title,
  );
});
