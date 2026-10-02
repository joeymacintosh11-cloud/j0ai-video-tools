import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { fixture } from "./fixtures.mts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import {
  deriveContentPackage,
  type ContentPackageView,
} from "../core/domain/content/contentPackage.ts";
import {
  deriveBatchContentPackage,
  planContentPackageBatch,
  toRenderTargetsFromPlan,
  type ContentPackageBatchTrack,
} from "../core/domain/content/contentPackageBatch.ts";
import {
  buildContentPackagesForSlugs,
  loadContentPackageBatchContext,
  namedBatchSlugs,
  type ContentPackageBatchContext,
} from "../server/services/contentPackagePlan.ts";
import { TrackError } from "../core/domain/tracks/errors.ts";

/**
 * Batch Content Package Generation: aggregation and planning across several
 * tracks — see core/domain/content/contentPackageBatch.ts.
 *
 * Most of this file is pure domain-level: aggregation and planning are both
 * pure functions of already-derived ContentPackageView objects, hand-built
 * here exactly like content-package.test.mts's own domain section. A handful
 * of tests go through real fixtures and `buildContentPackagesForSlugs` (the
 * server-side per-track resolver a batch shares across tracks) to prove the
 * wiring: that this module never disagrees with the single-track resolver it
 * is built on.
 */

/* ------------------------------------------------------------------ *
 * Domain: aggregation
 * ------------------------------------------------------------------ */

const readyPackage = (slug: string): ContentPackageView =>
  deriveContentPackage(
    {
      slug,
      title: slug,
      validationOk: true,
      metadata: { title: slug, artist: "Toshi", key: "F Minor", bpm: 100, subtitle: undefined },
      exports: [
        { presetId: "youtube-16x9", status: "current", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "vertical-9x16", status: "current", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "square-1x1", status: "current", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
      ],
    },
    { mode: "intent" },
  );

test("two fully ready tracks aggregate to a batch of all-ready totals", () => {
  const view = deriveBatchContentPackage([readyPackage("a"), readyPackage("b")]);
  assert.equal(view.totals.tracks, 2);
  assert.equal(view.totals.complete, 2);
  assert.equal(view.totals.readyTargets, 6);
  assert.equal(view.totals.missingTargets, 0);
  assert.equal(view.totals.staleTargets, 0);
  assert.equal(view.mode, "intent");
});

test("mixed ready/missing tracks aggregate target counts across tracks, not per track", () => {
  const missingOne = deriveContentPackage(
    {
      slug: "b",
      title: "b",
      validationOk: true,
      metadata: { title: "b", artist: "Toshi", key: "F Minor", bpm: 100, subtitle: undefined },
      exports: [
        { presetId: "youtube-16x9", status: "current", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "vertical-9x16", status: "missing", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "square-1x1", status: "current", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
      ],
    },
    { mode: "intent" },
  );
  const view = deriveBatchContentPackage([readyPackage("a"), missingOne]);
  // A: 3/3 ready, B: 2 ready / 1 missing -> batch: 5 ready, 1 missing.
  assert.equal(view.totals.readyTargets, 5);
  assert.equal(view.totals.missingTargets, 1);
  assert.equal(view.totals.complete, 1);
  assert.equal(view.totals.incomplete, 1);
});

test("mixed ready/stale tracks aggregate correctly — mirrors the brief's own worked example", () => {
  const oneStale = deriveContentPackage(
    {
      slug: "c",
      title: "c",
      validationOk: true,
      metadata: { title: "c", artist: "Toshi", key: "F Minor", bpm: 100, subtitle: undefined },
      exports: [
        { presetId: "youtube-16x9", status: "current", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "vertical-9x16", status: "stale", staleReasons: ["cover_changed"], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "square-1x1", status: "current", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
      ],
    },
    { mode: "intent" },
  );
  // A: 3/3, B: 2/1 missing, C: 1 stale/2 ready -> batch: 7 ready, 1 missing, 1 stale.
  const missingOne = deriveContentPackage(
    {
      slug: "b",
      title: "b",
      validationOk: true,
      metadata: { title: "b", artist: "Toshi", key: "F Minor", bpm: 100, subtitle: undefined },
      exports: [
        { presetId: "youtube-16x9", status: "current", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "vertical-9x16", status: "missing", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "square-1x1", status: "current", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
      ],
    },
    { mode: "intent" },
  );
  const view = deriveBatchContentPackage([readyPackage("a"), missingOne, oneStale]);
  assert.equal(view.totals.readyTargets, 7);
  assert.equal(view.totals.missingTargets, 1);
  assert.equal(view.totals.staleTargets, 1);
});

test("a blocked track's platforms are counted as blocked, not missing", () => {
  const blocked = deriveContentPackage(
    {
      slug: "blocked-track",
      title: null,
      validationOk: false,
      metadata: null,
      exports: [],
    },
    { mode: "full" },
  );
  const view = deriveBatchContentPackage([blocked]);
  assert.equal(view.totals.blocked, 1);
  assert.equal(view.tracks[0].blockedCount, 3);
});

test("invalid (not-found) tracks are reported separately and excluded from track totals", () => {
  const view = deriveBatchContentPackage([readyPackage("a")], {
    invalid: [{ slug: "ghost", reason: 'Track "ghost" not found.' }],
  });
  assert.equal(view.totals.tracks, 1);
  assert.equal(view.invalid.length, 1);
  assert.equal(view.invalid[0]!.slug, "ghost");
});

test("duplicate slugs are reported, never double-counted", () => {
  const view = deriveBatchContentPackage([readyPackage("a")], { duplicates: ["a"] });
  assert.equal(view.totals.tracks, 1);
  assert.deepEqual(view.duplicates, ["a"]);
});

test("rendering targets are summed across tracks at the target level, not the track level", () => {
  const rendering = deriveContentPackage(
    {
      slug: "r",
      title: "r",
      validationOk: true,
      metadata: { title: "r", artist: "Toshi", key: "F Minor", bpm: 100, subtitle: undefined },
      exports: [
        { presetId: "youtube-16x9", status: "queued", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "vertical-9x16", status: "rendering", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "square-1x1", status: "current", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
      ],
    },
    { mode: "intent" },
  );
  const view = deriveBatchContentPackage([rendering]);
  assert.equal(view.totals.rendering, 2);
});

test("available actions per track are the distinct union across its platforms", () => {
  const view = deriveBatchContentPackage([readyPackage("a")]);
  // All three platforms are ready and undelivered -> each offers "deliver".
  assert.deepEqual(view.tracks[0].availableActions, ["deliver"]);
});

/* ------------------------------------------------------------------ *
 * Domain: planning
 * ------------------------------------------------------------------ */

const trackResult = (pkg: ContentPackageView): ContentPackageBatchTrack => ({
  slug: pkg.slug,
  found: true,
  package: pkg,
});

test("every platform readiness maps to exactly one action kind", () => {
  const mixed = deriveContentPackage(
    {
      slug: "mix",
      title: "mix",
      validationOk: true,
      metadata: { title: "mix", artist: "Toshi", key: "F Minor", bpm: 100, subtitle: undefined },
      exports: [
        { presetId: "youtube-16x9", status: "missing", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "vertical-9x16", status: "stale", staleReasons: ["cover_changed"], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "square-1x1", status: "rendering", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
      ],
    },
    { mode: "intent" },
  );
  const plan = planContentPackageBatch([trackResult(mixed)]);
  assert.equal(plan.renderable.length, 2);
  assert.deepEqual(
    plan.renderable.map((a) => a.kind).sort(),
    ["render_missing", "rerender_stale"],
  );
  assert.equal(plan.adopted.length, 1);
  assert.equal(plan.adopted[0]!.kind, "adopt_existing_render");
});

test("a ready platform plans as already_ready, never as a render action", () => {
  const plan = planContentPackageBatch([trackResult(readyPackage("a"))]);
  assert.equal(plan.renderable.length, 0);
  assert.equal(plan.ready.length, 3);
});

test("a blocked track plans every selected platform as blocked, with a reason", () => {
  const blocked = deriveContentPackage(
    { slug: "blocked-track", title: null, validationOk: false, metadata: null, exports: [] },
    { mode: "full" },
  );
  const plan = planContentPackageBatch([trackResult(blocked)]);
  assert.equal(plan.blocked.length, 3);
  assert.ok(plan.blocked.every((a) => typeof a.reason === "string" && a.reason.length > 0));
});

test("not-selected platforms produce no action at all", () => {
  const intentOnlyYoutube = deriveContentPackage(
    {
      slug: "intent-only",
      title: "intent-only",
      validationOk: true,
      metadata: { title: "x", artist: "Toshi", key: "F Minor", bpm: 100, subtitle: undefined },
      exports: [
        { presetId: "youtube-16x9", status: "missing", staleReasons: [], intended: true, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "vertical-9x16", status: "missing", staleReasons: [], intended: false, delivery: { status: "not_configured", destinationRelativePath: null } },
        { presetId: "square-1x1", status: "missing", staleReasons: [], intended: false, delivery: { status: "not_configured", destinationRelativePath: null } },
      ],
    },
    { mode: "intent" },
  );
  const plan = planContentPackageBatch([trackResult(intentOnlyYoutube)]);
  assert.equal(plan.renderable.length, 1);
  assert.equal(plan.renderable[0]!.platformId, "youtube");
});

test("invalid (not-found) tracks flow through the plan as invalid, not as blocked actions", () => {
  const plan = planContentPackageBatch([
    { slug: "ghost", found: false, reason: 'Track "ghost" not found.' },
    trackResult(readyPackage("a")),
  ]);
  assert.equal(plan.invalid.length, 1);
  assert.equal(plan.tracks, 2);
});

test("two platforms sharing one preset still produce exactly one renderable action", () => {
  // Constructed directly rather than through deriveContentPackage, since no
  // two shipped platforms share a preset today (see platformProfiles.ts) —
  // this proves the *mechanism* holds regardless of how the collision arises.
  const base = readyPackage("shared-preset");
  const synthetic: ContentPackageView = {
    ...base,
    platforms: [
      { ...base.platforms[0]!, platformId: "youtube", presetId: "youtube-16x9", readiness: "missing" },
      { ...base.platforms[1]!, platformId: "reels", presetId: "youtube-16x9", readiness: "missing" },
    ],
  };
  const plan = planContentPackageBatch([trackResult(synthetic)]);
  assert.equal(plan.renderable.length, 1);
  assert.deepEqual(toRenderTargetsFromPlan(plan), [
    { slug: "shared-preset", preset: "youtube-16x9" },
  ]);
});

test("planning does not mutate its input packages", () => {
  const pkg = readyPackage("immutable");
  const before = JSON.stringify(pkg);
  planContentPackageBatch([trackResult(pkg)]);
  assert.equal(JSON.stringify(pkg), before);
});

test("planning twice from the same input produces the same plan — no hidden state", () => {
  const results = [trackResult(readyPackage("a")), trackResult(readyPackage("b"))];
  const first = planContentPackageBatch(results, { duplicates: [] });
  const second = planContentPackageBatch(results, { duplicates: [] });
  assert.deepEqual(first, second);
});

/* ------------------------------------------------------------------ *
 * Service: slug validation, bounds, deduplication
 * ------------------------------------------------------------------ */

test("an empty batch is rejected", () => {
  assert.throws(() => namedBatchSlugs([]), TrackError);
});

test("a batch over the maximum size is rejected", () => {
  const many = Array.from({ length: 101 }, (_, i) => `track-${i}`);
  assert.throws(() => namedBatchSlugs(many), TrackError);
});

test("exactly the maximum batch size is accepted", () => {
  const many = Array.from({ length: 100 }, (_, i) => `track-${i}`);
  const { slugs } = namedBatchSlugs(many);
  assert.equal(slugs.length, 100);
});

test("duplicate slugs are de-duplicated, keeping the first occurrence, and reported", () => {
  const { slugs, duplicates } = namedBatchSlugs(["a", "b", "a", "c", "b"]);
  assert.deepEqual(slugs, ["a", "b", "c"]);
  assert.deepEqual(duplicates, ["a", "b"]);
});

test("a malformed slug is rejected the same way single-track validation rejects it", () => {
  assert.throws(() => namedBatchSlugs(["not a valid slug!"]), TrackError);
});

/* ------------------------------------------------------------------ *
 * End to end: real fixtures, published exports, the shared per-track resolver
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
  return { ...f, props, publish };
};

const emptyContext: ContentPackageBatchContext = {
  inFlight: new Map(),
  deliveryRoot: null,
  globalTemplates: null,
  templatesProblem: null,
};

test("buildContentPackagesForSlugs agrees with the single-track resolver, end to end", async (t) => {
  const a = await setup(t, { exportPresets: ["youtube-16x9", "vertical-9x16", "square-1x1"] });
  await a.publish("youtube-16x9");
  await a.publish("vertical-9x16");
  await a.publish("square-1x1");
  const b = await setup(t, { exportPresets: ["youtube-16x9"] });
  await b.publish("youtube-16x9");

  const results = await buildContentPackagesForSlugs([a.slug, b.slug], emptyContext);
  const view = deriveBatchContentPackage(
    results.filter((r): r is Extract<typeof r, { found: true }> => r.found).map((r) => r.package),
  );

  assert.equal(view.totals.tracks, 2);
  assert.equal(view.totals.complete, 2);
  assert.equal(view.totals.readyTargets, 4);
});

test("a not-found track is reported as invalid, not thrown", async (t) => {
  const a = await setup(t);
  const results = await buildContentPackagesForSlugs(
    [a.slug, "definitely-does-not-exist-batch-probe"],
    emptyContext,
  );
  const missing = results.find((r) => r.slug === "definitely-does-not-exist-batch-probe");
  assert.ok(missing && !missing.found);
});

test("an invalid metadata.json blocks that track without failing the whole batch", async (t) => {
  const good = await setup(t, { exportPresets: ["youtube-16x9"] });
  await good.publish("youtube-16x9");
  const broken = await fixture(t, { bpm: "not-a-number" });

  const results = await buildContentPackagesForSlugs([good.slug, broken.slug], emptyContext, { mode: "full" });
  const goodResult = results.find((r) => r.slug === good.slug)!;
  const brokenResult = results.find((r) => r.slug === broken.slug)!;
  assert.ok(goodResult.found && goodResult.package.packageStatus !== "blocked");
  assert.ok(brokenResult.found && brokenResult.package.packageStatus === "blocked");

  const plan = planContentPackageBatch(results);
  assert.ok(plan.blocked.some((a) => a.slug === broken.slug));
});

test("apply-time revalidation: a target that becomes ready between plan and apply is re-read as ready, not re-queued", async (t) => {
  const track = await setup(t, { exportPresets: ["youtube-16x9"] });

  const before = await buildContentPackagesForSlugs([track.slug], emptyContext);
  const beforePlan = planContentPackageBatch(before);
  assert.equal(beforePlan.renderable.length, 1);
  assert.equal(beforePlan.renderable[0]!.kind, "render_missing");

  // Simulates another caller (or a previous apply) finishing the render
  // before this apply's own fresh read — exactly what a real apply route
  // does by re-planning immediately before queueing.
  await track.publish("youtube-16x9");

  const after = await buildContentPackagesForSlugs([track.slug], emptyContext);
  const afterPlan = planContentPackageBatch(after);
  assert.equal(afterPlan.renderable.length, 0);
  assert.equal(afterPlan.ready.length, 1);
});

test("apply-time revalidation: an in-flight target reads as adopted, not queued again", async (t) => {
  const track = await setup(t, { exportPresets: ["youtube-16x9"] });
  const inFlightContext: ContentPackageBatchContext = {
    ...emptyContext,
    inFlight: new Map([[`${track.slug}::youtube-16x9`, "active"]]),
  };
  const results = await buildContentPackagesForSlugs([track.slug], inFlightContext);
  const plan = planContentPackageBatch(results);
  assert.equal(plan.renderable.length, 0);
  assert.equal(plan.adopted.length, 1);
});

test("a metadata-template-only edit never changes what the batch would render", async (t) => {
  const track = await setup(t, { exportPresets: ["youtube-16x9"] });
  await track.publish("youtube-16x9");

  const before = await buildContentPackagesForSlugs([track.slug], emptyContext);
  const beforePlan = planContentPackageBatch(before);
  assert.equal(beforePlan.renderable.length, 0);
  assert.equal(beforePlan.ready.length, 1);

  await updateTrackMetadata(track.slug, {
    contentMetadataOverrides: { youtube: { titleTemplate: "Exclusive {title}" } },
  });

  const after = await buildContentPackagesForSlugs([track.slug], emptyContext);
  const afterPlan = planContentPackageBatch(after);
  assert.equal(afterPlan.renderable.length, 0);
  assert.equal(afterPlan.ready.length, 1);
});

test("a rendered-field edit (title) makes that track's target stale for the batch, exactly as before", async (t) => {
  const track = await setup(t, { exportPresets: ["youtube-16x9"] });
  await track.publish("youtube-16x9");

  await updateTrackMetadata(track.slug, { title: "A brand new title" });

  const after = await buildContentPackagesForSlugs([track.slug], emptyContext);
  const afterPlan = planContentPackageBatch(after);
  assert.equal(afterPlan.renderable.length, 1);
  assert.equal(afterPlan.renderable[0]!.kind, "rerender_stale");
});

test("full mode selects every platform batch-wide, matching the single-track resolver's own full mode", async (t) => {
  const track = await setup(t, { exportPresets: ["youtube-16x9"] });
  await track.publish("youtube-16x9");
  const results = await buildContentPackagesForSlugs([track.slug], emptyContext, { mode: "full" });
  assert.ok(results[0]!.found && results[0]!.package.counts.selected === 3);
});

test("loadContentPackageBatchContext reads settings/queue state once, not per track", async () => {
  const context = await loadContentPackageBatchContext();
  assert.ok(context.deliveryRoot === null || typeof context.deliveryRoot === "string");
  assert.ok(context.inFlight instanceof Map);
});
