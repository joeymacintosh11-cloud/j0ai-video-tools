import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import {
  planMissingExports,
  toRenderTargets,
} from "../services/workflows/exportPlan.ts";
import {
  renderedPresetIds,
  trackExportCoverage,
} from "../services/tracks/exportCoverage.ts";
import { trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { RENDER_PRESET_IDS } from "../core/domain/video/renderPresets.ts";
import { fixture } from "./fixtures.mts";
import type { TestContext } from "node:test";

/**
 * Export coverage and the missing-export planner.
 *
 * Queue state is handed to the planner rather than read from the render
 * manager, so these tests never fork a render process to describe what is
 * supposedly running.
 *
 * Catalogue runs see every track under public/tracks/, which includes real
 * tracks and any fixture another test file happens to be holding, so the
 * assertions here are scoped to each test's own slugs rather than to totals.
 */

/**
 * A fixture track that passes validation.
 *
 * The shared fixture writes metadata only, which is deliberately not renderable
 * — planning would correctly report it invalid. Export planning needs a track
 * that could be rendered, so the asset files are added here. Their contents do
 * not matter: nothing in the planner reads them.
 */
const renderableFixture = async (
  t: TestContext,
  extra: Record<string, unknown> = {},
) => {
  const f = await fixture(t, extra);

  await writeFile(f.cover, "placeholder");
  await writeFile(f.beat, "placeholder");

  return f;
};

/** Only the targets belonging to these tracks, as "slug/preset" strings. */
const targetsFor = (
  targets: readonly { slug: string; presetId: string }[],
  slugs: readonly string[],
): readonly string[] =>
  targets
    .filter((target) => slugs.includes(target.slug))
    .map((target) => `${target.slug}/${target.presetId}`);

/** Writes a fake export so coverage sees it, without rendering anything. */
const writeOutput = async (slug: string, presetId: string, bytes: number) => {
  const location = trackOutputLocation(slug, presetId as never);
  await mkdir(location.dir, { recursive: true });
  await writeFile(location.path, Buffer.alloc(bytes, 1));
};

const cleanOutputs = (t: TestContext, slug: string) => {
  t.after(() =>
    rm(trackOutputLocation(slug, "youtube-16x9").dir, {
      recursive: true,
      force: true,
    }),
  );
};

test("coverage reports every format, rendered or not", async (t) => {
  const f = await fixture(t);
  cleanOutputs(t, f.slug);

  const before = trackExportCoverage(f.slug);
  assert.deepEqual(
    before.map((entry) => entry.presetId),
    [...RENDER_PRESET_IDS],
    "one entry per format, in preset order",
  );
  assert.equal(before.every((entry) => !entry.rendered), true);
  assert.deepEqual(renderedPresetIds(f.slug), []);

  await writeOutput(f.slug, "vertical-9x16", 2048);

  const after = trackExportCoverage(f.slug);
  const vertical = after.find((entry) => entry.presetId === "vertical-9x16");

  assert.equal(vertical?.rendered, true);
  assert.equal(vertical?.bytes, 2048);
  assert.equal(vertical?.empty, false);
  assert.ok(vertical?.modifiedAt, "a rendered export reports when it was made");
  assert.ok(vertical?.outputLabel.endsWith("/vertical-9x16.mp4"));
  assert.deepEqual(renderedPresetIds(f.slug), ["vertical-9x16"]);
});

test("a zero-byte output is a broken leftover, not an export", async (t) => {
  const f = await fixture(t);
  cleanOutputs(t, f.slug);

  await writeOutput(f.slug, "square-1x1", 0);

  const square = trackExportCoverage(f.slug).find(
    (entry) => entry.presetId === "square-1x1",
  );

  assert.equal(square?.rendered, false, "an empty file does not count");
  assert.equal(square?.empty, true);
  assert.equal(square?.bytes, 0);
  assert.deepEqual(renderedPresetIds(f.slug), []);
});

test("only the formats that are missing are planned", async (t) => {
  const f = await renderableFixture(t);
  cleanOutputs(t, f.slug);

  await writeOutput(f.slug, "youtube-16x9", 1024);

  const result = await planMissingExports({
    slugs: [f.slug],
    presetIds: [...RENDER_PRESET_IDS],
  });

  assert.deepEqual(
    result.missing.map((target) => target.presetId),
    ["vertical-9x16", "square-1x1"],
  );
  assert.deepEqual(
    result.skippedExisting.map((target) => target.presetId),
    ["youtube-16x9"],
  );
  assert.deepEqual(result.invalid, []);
});

test("an empty output is planned again, so a broken render gets remade", async (t) => {
  const f = await renderableFixture(t);
  cleanOutputs(t, f.slug);

  await writeOutput(f.slug, "youtube-16x9", 0);

  const result = await planMissingExports({
    slugs: [f.slug],
    presetIds: ["youtube-16x9"],
  });

  assert.deepEqual(
    result.missing.map((target) => target.presetId),
    ["youtube-16x9"],
  );
});

test("nothing is planned when every requested export exists", async (t) => {
  const f = await renderableFixture(t);
  cleanOutputs(t, f.slug);

  for (const presetId of RENDER_PRESET_IDS) {
    await writeOutput(f.slug, presetId, 512);
  }

  const result = await planMissingExports({
    slugs: [f.slug],
    presetIds: [...RENDER_PRESET_IDS],
  });

  assert.deepEqual(result.missing, []);
  assert.equal(result.skippedExisting.length, RENDER_PRESET_IDS.length);
});

test("queued and running targets are skipped, and reported apart", async (t) => {
  const f = await renderableFixture(t);
  cleanOutputs(t, f.slug);

  // Describing the queue directly, rather than starting real renders: the
  // point here is how the plan reads in-flight work, not how forking behaves.
  const inFlight = new Map<string, "queued" | "active">([
    [`${f.slug}::youtube-16x9`, "active"],
    [`${f.slug}::vertical-9x16`, "queued"],
  ]);

  const result = await planMissingExports({
    slugs: [f.slug],
    presetIds: [...RENDER_PRESET_IDS],
    inFlight,
  });

  assert.deepEqual(
    result.skippedActive.map((target) => target.presetId),
    ["youtube-16x9"],
  );
  assert.deepEqual(
    result.skippedQueued.map((target) => target.presetId),
    ["vertical-9x16"],
  );
  assert.deepEqual(
    result.missing.map((target) => target.presetId),
    ["square-1x1"],
    "only the format with no work in flight is missing",
  );
});

test("an unrenderable track is reported once, not once per format", async (t) => {
  const f = await renderableFixture(t);
  cleanOutputs(t, f.slug);

  // Break the metadata so validation fails.
  await writeFile(f.metadata, "{ not json");

  const result = await planMissingExports({
    slugs: [f.slug],
    presetIds: [...RENDER_PRESET_IDS],
  });

  assert.equal(result.invalid.length, 1, "one entry for the track");
  assert.equal(result.invalid[0].slug, f.slug);
  assert.ok(result.invalid[0].reason.length > 0);
  assert.deepEqual(result.missing, []);
});

test("a track that does not exist is reported as not found", async () => {

  const result = await planMissingExports({
    slugs: ["definitely-not-a-track"],
    presetIds: ["youtube-16x9"],
  });

  assert.deepEqual(result.invalid, [
    {
      slug: "definitely-not-a-track",
      code: "TRACK_NOT_FOUND",
      reason: 'Track "definitely-not-a-track" not found.',
    },
  ]);
});

test("ordering is deterministic: tracks as given, formats canonical", async (t) => {
  const a = await renderableFixture(t);
  const b = await renderableFixture(t);
  cleanOutputs(t, a.slug);
  cleanOutputs(t, b.slug);

  const result = await planMissingExports({
    slugs: [b.slug, a.slug],
    // Deliberately out of canonical order, and with a duplicate.
    presetIds: ["square-1x1", "youtube-16x9", "square-1x1"],
  });

  assert.deepEqual(
    result.missing.map((target) => `${target.slug}:${target.presetId}`),
    [
      `${b.slug}:youtube-16x9`,
      `${b.slug}:square-1x1`,
      `${a.slug}:youtube-16x9`,
      `${a.slug}:square-1x1`,
    ],
  );
});

test("a repeated track is planned once", async (t) => {
  const f = await renderableFixture(t);
  cleanOutputs(t, f.slug);

  const result = await planMissingExports({
    slugs: [f.slug, f.slug],
    presetIds: ["youtube-16x9"],
  });

  assert.equal(result.missing.length, 1);
});

test("empty input and unknown formats are refused", async (t) => {
  const f = await renderableFixture(t);

  await assert.rejects(
    () => planMissingExports({ slugs: [], presetIds: ["youtube-16x9"] }),
    { code: "INVALID_REQUEST" },
  );
  await assert.rejects(
    () => planMissingExports({ slugs: [f.slug], presetIds: [] }),
    { code: "INVALID_REQUEST" },
  );
  await assert.rejects(
    () =>
      planMissingExports({
        slugs: [f.slug],
        presetIds: ["tiktok" as never],
      }),
    { code: "INVALID_PRESET" },
  );
  await assert.rejects(
    () =>
      planMissingExports({ slugs: ["../etc"], presetIds: ["square-1x1"] }),
    { code: "INVALID_SLUG" },
  );
});

test("the plan converts straight into batch targets", async (t) => {
  const f = await renderableFixture(t);
  cleanOutputs(t, f.slug);

  const result = await planMissingExports({
    slugs: [f.slug],
    presetIds: ["youtube-16x9", "square-1x1"],
  });

  assert.deepEqual(toRenderTargets(result), [
    { slug: f.slug, preset: "youtube-16x9" },
    { slug: f.slug, preset: "square-1x1" },
  ]);
});

/* ------------------------------------------------------------------ *
 * Declared intent
 * ------------------------------------------------------------------ */

test("with no formats named, each track's own intent decides", async (t) => {
  const a = await renderableFixture(t, { exportPresets: ["youtube-16x9"] });
  const b = await renderableFixture(t, {
    exportPresets: ["youtube-16x9", "vertical-9x16"],
  });
  cleanOutputs(t, a.slug);
  cleanOutputs(t, b.slug);

  const result = await planMissingExports({ slugs: [a.slug, b.slug] });

  assert.deepEqual(targetsFor(result.missing, [a.slug, b.slug]), [
    `${a.slug}/youtube-16x9`,
    `${b.slug}/youtube-16x9`,
    `${b.slug}/vertical-9x16`,
  ]);
  assert.deepEqual(
    result.intendedTargets.map((target) => target.presetId),
    ["youtube-16x9", "youtube-16x9", "vertical-9x16"],
    "intent is per track, never flattened into one list for all of them",
  );
});

test("named formats override intent for the request", async (t) => {
  const f = await renderableFixture(t, { exportPresets: ["youtube-16x9"] });
  cleanOutputs(t, f.slug);

  const result = await planMissingExports({
    slugs: [f.slug],
    presetIds: ["square-1x1"],
  });

  assert.deepEqual(targetsFor(result.missing, [f.slug]), [
    `${f.slug}/square-1x1`,
  ]);
});

test("a track declaring nothing still means every format", async (t) => {
  const f = await renderableFixture(t);
  cleanOutputs(t, f.slug);

  const result = await planMissingExports({ slugs: [f.slug] });

  assert.deepEqual(
    result.missing.map((target) => target.presetId),
    [...RENDER_PRESET_IDS],
    "undeclared behaves exactly as it did before intent existed",
  );
});

test("an export outside a track's intent is left alone", async (t) => {
  const f = await renderableFixture(t, { exportPresets: ["youtube-16x9"] });
  cleanOutputs(t, f.slug);

  await writeOutput(f.slug, "youtube-16x9", 1024);

  const result = await planMissingExports({ slugs: [f.slug] });

  assert.deepEqual(result.missing, []);
  assert.deepEqual(
    result.skippedExisting.map((target) => target.presetId),
    ["youtube-16x9"],
  );
  assert.equal(
    result.intendedTargets.length,
    1,
    "the two formats this track does not ship in are not planned at all",
  );
});

test("the catalogue covers every track, each on its own intent", async (t) => {
  const a = await renderableFixture(t, { exportPresets: ["square-1x1"] });
  const b = await renderableFixture(t, {
    exportPresets: ["youtube-16x9", "square-1x1"],
  });
  cleanOutputs(t, a.slug);
  cleanOutputs(t, b.slug);

  await writeOutput(b.slug, "youtube-16x9", 2048);

  const result = await planMissingExports({});

  assert.equal(result.catalogue, true);
  assert.ok(result.tracks >= 2, "every track folder was considered");
  // A catalogue run is ordered by slug, not by the order tracks were made —
  // fixture slugs are random, so sorting is what states that contract.
  assert.deepEqual(
    targetsFor(result.missing, [a.slug, b.slug]),
    [`${a.slug}/square-1x1`, `${b.slug}/square-1x1`].sort(),
  );
  assert.deepEqual(targetsFor(result.skippedExisting, [b.slug]), [
    `${b.slug}/youtube-16x9`,
  ]);
});

test("a catalogue with nothing missing plans nothing", async (t) => {
  const f = await renderableFixture(t, { exportPresets: ["vertical-9x16"] });
  cleanOutputs(t, f.slug);

  await writeOutput(f.slug, "vertical-9x16", 512);

  const result = await planMissingExports({
    slugs: [f.slug],
    presetIds: null,
  });

  assert.deepEqual(result.missing, []);
  assert.equal(result.intendedTargets.length, 1);
});

test("an unrenderable track is reported once however many formats it wants", async (t) => {
  const f = await fixture(t, {
    exportPresets: ["youtube-16x9", "vertical-9x16", "square-1x1"],
  });
  cleanOutputs(t, f.slug);

  const result = await planMissingExports({ slugs: [f.slug] });

  assert.equal(result.invalid.length, 1);
  assert.deepEqual(result.intendedTargets, []);
});

test("the catalogue is not something an empty track list can ask for", async () => {
  await assert.rejects(() => planMissingExports({ slugs: [] }), {
    code: "INVALID_REQUEST",
  });
});
