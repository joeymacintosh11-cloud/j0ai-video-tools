import assert from "node:assert/strict";
import test from "node:test";
import { deriveContentPackage, type ContentPackageView } from "../core/domain/content/contentPackage.ts";
import { deriveBatchContentPackage, replaceBatchTrackPackage } from "../core/domain/content/contentPackageBatch.ts";
import type { ContentPackageBatchJobReferenceView, RenderJobView } from "../core/domain/api/views.ts";
import { deriveLiveBatchProgress } from "../ui/components/batchProgressModel.ts";

const pkg = (slug: string, statuses: readonly ("current" | "missing" | "stale")[], mode: "intent" | "full" = "full"): ContentPackageView =>
  deriveContentPackage({
    slug, title: slug, validationOk: true,
    metadata: { title: slug, artist: "Toshi", key: "C Minor", bpm: 90 },
    exports: (["youtube-16x9", "vertical-9x16", "square-1x1"] as const).map((presetId, index) => ({
      presetId, status: statuses[index]!, staleReasons: statuses[index] === "stale" ? ["metadata_changed" as const] : [],
      intended: true, delivery: { status: "not_configured" as const, destinationRelativePath: null },
    })),
  }, { mode });

const ref = (slug: string, platformId: "reels" | "instagram-square", presetId: "vertical-9x16" | "square-1x1", jobId: string): ContentPackageBatchJobReferenceView => ({
  actionId: `${slug}::${platformId}::${presetId}`, slug, platformId, presetId, jobId, outcome: "queued",
});

const job = (id: string, slug: string, presetId: "vertical-9x16" | "square-1x1", status: RenderJobView["status"], progress = 0): RenderJobView => ({
  id, slug, presetId, engine: "remotion", batchId: "batch", status, progress, framesRendered: progress > 0 ? 54 : null,
  totalFrames: progress > 0 ? 100 : null, fps: null, elapsedMs: 0, startedAt: null,
  queuedAt: "2026-01-01T00:00:00Z", finishedAt: null, outputPath: null, outputLabel: null, error: null,
});

test("live totals overlay two exact jobs without counting missing/stale twice", () => {
  const view = deriveBatchContentPackage([
    pkg("a", ["current", "current", "current"]),
    pkg("b", ["current", "missing", "current"]),
    pkg("c", ["current", "current", "stale"]),
  ]);
  const refs = [ref("b", "reels", "vertical-9x16", "one"), ref("c", "instagram-square", "square-1x1", "two")];
  const live = deriveLiveBatchProgress(view, refs, {
    one: job("one", "b", "vertical-9x16", "rendering", 0.54),
    two: job("two", "c", "square-1x1", "queued"),
  });
  assert.deepEqual(live.totals, { total: 9, ready: 7, missing: 0, stale: 0, blocked: 0, queued: 1, preparing: 0, rendering: 1, cancelling: 0, checking: 0 });
  assert.equal(live.tracks[1]!.platforms[1]!.progressPercent, 54);
  assert.equal(live.tracks[1]!.ready, 2);
});

test("completed render waits for authoritative readiness and can remain stale", () => {
  const before = deriveBatchContentPackage([pkg("b", ["current", "missing", "current"])]);
  const refs = [ref("b", "reels", "vertical-9x16", "one")];
  const completed = { ...job("one", "b", "vertical-9x16", "completed", 1), finishedAt: "2026-01-01T00:00:01Z" };
  const pending = deriveLiveBatchProgress(before, refs, { one: completed }, new Set(["b"]));
  assert.equal(pending.totals.checking, 1);
  assert.equal(pending.totals.ready, 2);

  const after = replaceBatchTrackPackage(before, pkg("b", ["current", "stale", "current"]), () => "later");
  const live = deriveLiveBatchProgress(after, refs, { one: completed });
  assert.equal(live.totals.stale, 1);
  assert.equal(live.totals.ready, 2);
  assert.equal(live.tracks[0]!.platforms[1]!.jobState, "completed");
  assert.equal(after.inspectedAt, "later");
});

test("failure and cancellation remain target-specific while sibling readiness survives", () => {
  const view = deriveBatchContentPackage([pkg("b", ["current", "missing", "stale"])]);
  const failed = { ...job("one", "b", "vertical-9x16", "failed"), error: { code: "RENDER_FAILED" as const, message: "encoder failed" } };
  const cancelled = job("two", "b", "square-1x1", "cancelled");
  const live = deriveLiveBatchProgress(view,
    [ref("b", "reels", "vertical-9x16", "one"), ref("b", "instagram-square", "square-1x1", "two")],
    { one: failed, two: cancelled });
  assert.equal(live.totals.ready, 1);
  assert.equal(live.totals.missing, 1);
  assert.equal(live.totals.stale, 1);
  assert.equal(live.tracks[0]!.platforms[1]!.error, "encoder failed");
  assert.equal(live.tracks[0]!.platforms[2]!.jobState, "cancelled");
});

test("cancelling is a transient job overlay, never durable package readiness", () => {
  const view = deriveBatchContentPackage([pkg("b", ["current", "missing", "current"])]);
  const refs = [ref("b", "reels", "vertical-9x16", "one")];
  const rendering = job("one", "b", "vertical-9x16", "rendering", 0.54);
  const pending = deriveLiveBatchProgress(view, refs, { one: rendering }, new Set(), new Set(["one"]));
  assert.equal(pending.totals.cancelling, 1);
  assert.equal(pending.totals.rendering, 0);
  assert.equal(pending.tracks[0]!.cancelling, 1);
  assert.equal(pending.tracks[0]!.platforms[1]!.jobState, "cancelling");

  const cancelled = deriveLiveBatchProgress(view, refs, {
    one: job("one", "b", "vertical-9x16", "cancelled"),
  });
  assert.equal(cancelled.totals.cancelling, 0);
  assert.equal(cancelled.totals.missing, 1, "underlying package readiness reappears");
  assert.equal(cancelled.tracks[0]!.platforms[1]!.jobState, "cancelled");
});

test("preparing remains distinct from rendering in target and batch totals", () => {
  const view = deriveBatchContentPackage([pkg("b", ["current", "missing", "current"])]);
  const refs = [ref("b", "reels", "vertical-9x16", "one")];
  const live = deriveLiveBatchProgress(view, refs, {
    one: job("one", "b", "vertical-9x16", "preparing"),
  });
  assert.equal(live.totals.preparing, 1);
  assert.equal(live.totals.rendering, 0);
  assert.equal(live.tracks[0]!.preparing, 1);
  assert.equal(live.tracks[0]!.platforms[1]!.jobState, "preparing");
});

test("job references stay attached to exact platform targets across mode and selection changes", () => {
  const refs = [ref("b", "reels", "vertical-9x16", "one"), ref("c", "instagram-square", "square-1x1", "two")];
  const jobs = { one: job("one", "b", "vertical-9x16", "rendering", 0.2), two: job("two", "c", "square-1x1", "queued") };
  const onlyB = deriveLiveBatchProgress(deriveBatchContentPackage([pkg("b", ["current", "missing", "current"], "intent")]), refs, jobs);
  assert.equal(onlyB.totals.rendering, 1);
  assert.equal(onlyB.totals.queued, 0);
  const full = deriveLiveBatchProgress(deriveBatchContentPackage([pkg("b", ["current", "missing", "current"], "full"), pkg("c", ["current", "current", "stale"], "full")]), refs, jobs);
  assert.equal(full.totals.rendering, 1);
  assert.equal(full.totals.queued, 1);
});

test("twelve tracked targets and a shared adopted job keep one bucket per target", () => {
  const slugs = Array.from({ length: 12 }, (_, i) => `track-${i}`);
  const view = deriveBatchContentPackage(slugs.map((slug) => pkg(slug, ["current", "missing", "current"])));
  const refs = slugs.map((slug, i) => ref(slug, "reels", "vertical-9x16", i < 2 ? "shared" : `job-${i}`));
  const jobs: Record<string, RenderJobView> = {
    shared: job("shared", slugs[0]!, "vertical-9x16", "rendering", 0.25),
  };
  for (let i = 2; i < 12; i++) jobs[`job-${i}`] = job(`job-${i}`, slugs[i]!, "vertical-9x16", i % 2 ? "queued" : "rendering");
  const live = deriveLiveBatchProgress(view, refs, jobs);
  assert.equal(new Set(refs.map((item) => item.jobId)).size, 11);
  assert.deepEqual(live.totals, {
    total: 36, ready: 24, missing: 0, stale: 0, blocked: 0, queued: 5, preparing: 0, rendering: 7, cancelling: 0, checking: 0,
  });
});
