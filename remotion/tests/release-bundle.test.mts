import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import {
  generateReleaseBundle,
  releaseBundlePaths,
  releaseBundleState,
} from "../services/delivery/releaseBundle.ts";
import type { DeliverySettings } from "../services/delivery/deliverySettings.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import {
  RELEASE_BUNDLE_SCHEMA_VERSION,
  RELEASE_JSON_FILENAME,
  RELEASE_MARKDOWN_FILENAME,
  type ReleaseBundle,
} from "../src/domain/delivery/releaseBundle.ts";
import { parseTrackMetadata } from "../src/domain/tracks/metadata.ts";
import type { RenderPresetId } from "../src/domain/video/renderPresets.ts";
import { fixture } from "./fixtures.mts";

/**
 * Release bundles.
 *
 * Real directories in a temp root, because publication is filesystem
 * behaviour: an atomic rename, a preserved previous bundle, a cleaned-up temp
 * file. Settings are passed in explicitly, so no test reads or writes the
 * project's own delivery.local.json.
 */

const execFileAsync = promisify(execFile);

const destination = async (t: TestContext) => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "toshi-bundle-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const settingsFor = (
  root: string | null,
  autoUpdateReleaseBundle = false,
): DeliverySettings => ({
  schemaVersion: 1,
  root,
  autoDeliver: false,
  autoUpdateReleaseBundle,
});

/** A pinned clock, so a rendered document is reproducible. */
const AT = "2026-09-18T19:42:07.000Z";
const at = () => AT;

/**
 * A renderable track with real audio.
 *
 * The audio is real because a bundle reports the rendered duration, which comes
 * from the source through ffprobe — the same calculation the composition makes.
 */
const setup = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const f = await fixture(t, extra);
  const metadataPath = f.metadata;

  await writeFile(f.cover, "cover");
  await execFileAsync("ffmpeg", [
    "-v", "error", "-f", "lavfi", "-i", "sine=frequency=220:duration=2",
    "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", "-y", f.beat,
  ]);
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));

  const metadata = parseTrackMetadata(
    JSON.parse(await readFile(metadataPath, "utf8")),
    "fixture",
  );
  const props = buildTrackProps({ slug: f.slug, metadata, analysisAvailable: true });

  const publish = (
    presetId: RenderPresetId = "youtube-16x9",
    body = "a rendered video",
  ) =>
    publishExport(f.slug, presetId, fingerprintInputs(props, presetId), async (file) => {
      await writeFile(file, body);
    });

  const facts = (presetId: RenderPresetId = "youtube-16x9") =>
    trackExportCoverage(f.slug, metadata).find((e) => e.presetId === presetId)!;

  const deliver = (presetId: RenderPresetId, root: string) =>
    deliverExport({ slug: f.slug, presetId, settings: settingsFor(root) });

  return { ...f, metadataPath, metadata, props, publish, facts, deliver };
};

const readBundle = async (root: string, folder: string): Promise<ReleaseBundle> =>
  JSON.parse(
    await readFile(path.join(root, folder, RELEASE_JSON_FILENAME), "utf8"),
  ) as ReleaseBundle;

const readMarkdown = (root: string, folder: string): Promise<string> =>
  readFile(path.join(root, folder, RELEASE_MARKDOWN_FILENAME), "utf8");

const temps = async (directory: string): Promise<string[]> =>
  (await readdir(directory)).filter((name) => name.includes(".tmp-"));

/* ------------------------------------------------------------------ *
 * A complete release
 * ------------------------------------------------------------------ */

test("a fully delivered track describes everything it shipped", async (t) => {
  const f = await setup(t, {
    exportPresets: ["youtube-16x9", "square-1x1"],
    deliveryFolder: "Ghetto Geek",
  });
  const root = await destination(t);

  await f.publish("youtube-16x9");
  await f.publish("square-1x1");
  await f.deliver("youtube-16x9", root);
  await f.deliver("square-1x1", root);

  const result = await generateReleaseBundle({
    slug: f.slug,
    settings: settingsFor(root),
    now: at,
  });

  assert.equal(result.generated, true);
  assert.equal(result.freshness, "current");
  assert.equal(result.delivered, 2);
  assert.equal(result.missing, 0);
  assert.equal(result.relativePath, "Ghetto Geek/release.json");

  const bundle = await readBundle(root, "Ghetto Geek");

  assert.equal(bundle.schemaVersion, RELEASE_BUNDLE_SCHEMA_VERSION);
  assert.equal(bundle.generatedAt, AT);
  assert.equal(bundle.folder, "Ghetto Geek");
  assert.equal(bundle.track.slug, f.slug);
  assert.equal(bundle.track.artist, "Toshi");
  assert.equal(bundle.track.key, "F Minor");
  assert.equal(bundle.track.bpm, 100);

  // Canonical preset order, not the order things were delivered in.
  assert.deepEqual(bundle.intendedPresets, ["youtube-16x9", "square-1x1"]);
  assert.deepEqual(
    bundle.deliveries.map((entry) => entry.presetId),
    ["youtube-16x9", "square-1x1"],
  );
  assert.deepEqual(bundle.outdated, []);
  assert.deepEqual(bundle.missing, []);

  const [landscape, square] = bundle.deliveries;
  assert.equal(landscape.filename, `${f.slug}-youtube-16x9.mp4`);
  assert.equal(landscape.label, "YouTube 16:9");
  assert.equal(landscape.width, 1920);
  assert.equal(landscape.height, 1080);
  assert.equal(landscape.fps, 30);
  assert.equal(landscape.status, "delivered");
  assert.equal(landscape.reason, null);
  assert.equal(landscape.bytes, "a rendered video".length);
  assert.ok(landscape.deliveredAt);
  assert.equal(landscape.exportFingerprint, f.facts("youtube-16x9").inputFingerprint);

  // 2 seconds of audio at 30fps, ceil'd into whole frames.
  assert.equal(landscape.durationFrames, 60);
  assert.equal(landscape.durationSeconds, 2);
  assert.equal(square.durationFrames, 60);
});

test("the Markdown is readable and deterministic", async (t) => {
  const f = await setup(t, {
    exportPresets: ["youtube-16x9", "square-1x1"],
    deliveryFolder: "Ghetto Geek",
    subtitle: "Boom bap soul, trap bounce and latin heat.",
  });
  const root = await destination(t);

  await f.publish("youtube-16x9");
  await f.deliver("youtube-16x9", root);

  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root), now: at });
  const first = await readMarkdown(root, "Ghetto Geek");

  assert.match(first, /^# Fixture — Toshi$/m);
  assert.match(first, /^Key: F Minor$/m);
  assert.match(first, /^BPM: 100$/m);
  assert.match(first, /^Boom bap soul, trap bounce and latin heat\.$/m);
  assert.match(first, /^## Delivered$/m);
  assert.match(first, /^- YouTube 16:9 — 1920×1080 — 0:02 — 0\.0 MB$/m);
  assert.match(first, /^## Missing$/m);
  assert.match(first, /^- Square 1:1 — not rendered yet$/m);
  assert.match(first, /^Generated 2026-09-\d\d \d\d:\d\d · bundle `[0-9a-f]{12}`$/m);

  // No section is printed empty, and nothing leaks an absolute path.
  assert.equal(first.includes("## Outdated"), false);
  assert.equal(first.includes(root), false);

  // The same state renders the same document.
  await generateReleaseBundle({
    slug: f.slug,
    settings: settingsFor(root),
    force: true,
    now: at,
  });
  assert.equal(await readMarkdown(root, "Ghetto Geek"), first);
});

test("release.json carries no absolute machine-local path", async (t) => {
  const f = await setup(t);
  const root = await destination(t);

  await f.publish();
  await f.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root), now: at });

  const raw = await readFile(
    path.join(root, f.slug, RELEASE_JSON_FILENAME),
    "utf8",
  );

  assert.equal(raw.includes(root), false, "no destination root");
  assert.equal(raw.includes(process.cwd()), false, "no project path");
  assert.equal(raw.includes("/Users/"), false, "no home directory");
  assert.doesNotThrow(() => JSON.parse(raw));
});

/* ------------------------------------------------------------------ *
 * Partial releases
 * ------------------------------------------------------------------ */

test("a partial release is valid, and says what is missing", async (t) => {
  const f = await setup(t, {
    exportPresets: ["youtube-16x9", "vertical-9x16", "square-1x1"],
  });
  const root = await destination(t);

  await f.publish("youtube-16x9");
  await f.publish("vertical-9x16");
  await f.deliver("youtube-16x9", root);
  await f.deliver("vertical-9x16", root);

  const result = await generateReleaseBundle({
    slug: f.slug,
    settings: settingsFor(root),
    now: at,
  });

  assert.equal(result.generated, true);
  assert.equal(result.delivered, 2);
  assert.equal(result.missing, 1);

  const bundle = await readBundle(root, f.slug);
  assert.deepEqual(
    bundle.deliveries.map((entry) => entry.presetId),
    ["youtube-16x9", "vertical-9x16"],
  );
  assert.deepEqual(
    bundle.missing.map((entry) => [entry.presetId, entry.reason]),
    [["square-1x1", "export_missing"]],
  );
  // A missing format still names the file it would be, and claims no size.
  assert.equal(bundle.missing[0].filename, `${f.slug}-square-1x1.mp4`);
  assert.equal(bundle.missing[0].bytes, null);
  assert.equal(bundle.missing[0].deliveredAt, null);
});

test("a bundle can be generated with nothing delivered at all", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);

  const result = await generateReleaseBundle({
    slug: f.slug,
    settings: settingsFor(root),
    now: at,
  });

  assert.equal(result.generated, true);
  assert.equal(result.delivered, 0);
  assert.equal(result.missing, 1);
  assert.match(await readMarkdown(root, f.slug), /Nothing has been delivered yet\./);
});

/* ------------------------------------------------------------------ *
 * Not-delivered states
 * ------------------------------------------------------------------ */

test("an existing MP4 without a receipt is not reported as shipped", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);

  await f.publish();
  // A file someone put there by hand is not evidence of a delivery.
  const folder = path.join(root, f.slug);
  await rm(folder, { recursive: true, force: true });
  await execFileAsync("mkdir", ["-p", folder]);
  await writeFile(path.join(folder, `${f.slug}-youtube-16x9.mp4`), "copied by hand");

  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root), now: at });
  const bundle = await readBundle(root, f.slug);

  assert.deepEqual(bundle.deliveries, []);
  assert.deepEqual(
    bundle.missing.map((entry) => entry.presetId),
    ["youtube-16x9"],
  );
});

test("a stale canonical export is not reported as shipped", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);

  await f.publish();
  await f.deliver("youtube-16x9", root);

  // Changing an input makes the export stale, so what is at the destination no
  // longer represents what should ship.
  await writeFile(f.cover, "a different cover");

  await generateReleaseBundle({
    slug: f.slug,
    settings: settingsFor(root),
    force: true,
    now: at,
  });
  const bundle = await readBundle(root, f.slug);

  assert.deepEqual(bundle.deliveries, []);
  assert.deepEqual(
    bundle.outdated.map((entry) => [entry.presetId, entry.reason]),
    [["youtube-16x9", "export_not_current"]],
  );
  assert.match(
    await readMarkdown(root, f.slug),
    /^- YouTube 16:9 — export is out of date — re-render it$/m,
  );
});

test("a re-rendered export leaves the previous delivery outdated", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);

  await f.publish("youtube-16x9", "version one");
  await f.deliver("youtube-16x9", root);
  await f.publish("youtube-16x9", "version two");

  await generateReleaseBundle({
    slug: f.slug,
    settings: settingsFor(root),
    force: true,
    now: at,
  });
  const bundle = await readBundle(root, f.slug);

  assert.deepEqual(bundle.deliveries, []);
  assert.deepEqual(
    bundle.outdated.map((entry) => [entry.presetId, entry.reason]),
    [["youtube-16x9", "export_changed"]],
  );

  // Delivering again returns it to shipped, and nothing was deleted meanwhile.
  await f.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root), now: at });
  const after = await readBundle(root, f.slug);
  assert.deepEqual(
    after.deliveries.map((entry) => entry.presetId),
    ["youtube-16x9"],
  );
});

/* ------------------------------------------------------------------ *
 * Freshness
 * ------------------------------------------------------------------ */

test("with no destination there is nothing to describe", async (t) => {
  const f = await setup(t);

  const state = await releaseBundleState(f.slug, settingsFor(null));
  assert.equal(state.freshness, "not_configured");
  assert.equal(state.relativePath, null);

  const result = await generateReleaseBundle({
    slug: f.slug,
    settings: settingsFor(null),
    now: at,
  });
  assert.equal(result.generated, false);
  assert.match(result.problem ?? "", /no export destination/i);
});

test("freshness follows delivery, metadata and intent", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root);
  const state = () => releaseBundleState(f.slug, settings);

  assert.equal((await state()).freshness, "missing");

  await f.publish();
  await f.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: f.slug, settings, now: at });
  assert.equal((await state()).freshness, "current");

  // A metadata edit changes what the bundle says about the track.
  const original = JSON.parse(await readFile(f.metadataPath, "utf8"));
  await writeFile(
    f.metadataPath,
    JSON.stringify({ ...original, title: "Renamed" }),
  );
  assert.equal((await state()).freshness, "outdated");

  await generateReleaseBundle({ slug: f.slug, settings, now: at });
  assert.equal((await state()).freshness, "current");

  // Declaring another format changes what is missing.
  await writeFile(
    f.metadataPath,
    JSON.stringify({
      ...original,
      title: "Renamed",
      exportPresets: ["youtube-16x9", "square-1x1"],
    }),
  );
  assert.equal((await state()).freshness, "outdated");

  await generateReleaseBundle({ slug: f.slug, settings, now: at });
  const bundle = await readBundle(root, f.slug);
  assert.equal(bundle.missing.length, 1);
  assert.equal((await state()).freshness, "current");
});

test("a new delivery makes the bundle outdated until it is regenerated", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9", "square-1x1"] });
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish("youtube-16x9");
  await f.publish("square-1x1");
  await f.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: f.slug, settings, now: at });
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "current");

  await f.deliver("square-1x1", root);
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "outdated");

  await generateReleaseBundle({ slug: f.slug, settings, now: at });
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "current");
});

test("changing the destination folder leaves the new folder without a bundle", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish();
  await f.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: f.slug, settings, now: at });

  const original = JSON.parse(await readFile(f.metadataPath, "utf8"));
  await writeFile(
    f.metadataPath,
    JSON.stringify({ ...original, deliveryFolder: "Somewhere Else" }),
  );

  const state = await releaseBundleState(f.slug, settings);
  assert.equal(state.freshness, "missing");
  assert.equal(state.relativePath, "Somewhere Else/release.json");

  // The old folder's bundle is left alone rather than deleted.
  assert.equal(
    (await readdir(path.join(root, f.slug))).includes(RELEASE_JSON_FILENAME),
    true,
  );
});

test("an already current bundle is not rewritten unless forced", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish();
  await f.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: f.slug, settings, now: at });
  const first = await readBundle(root, f.slug);

  const second = await generateReleaseBundle({
    slug: f.slug,
    settings,
    now: () => "2030-01-01T00:00:00.000Z",
  });
  assert.equal(second.generated, false);
  assert.equal(second.freshness, "current");
  assert.equal((await readBundle(root, f.slug)).generatedAt, first.generatedAt);

  const forced = await generateReleaseBundle({
    slug: f.slug,
    settings,
    force: true,
    now: () => "2030-01-01T00:00:00.000Z",
  });
  assert.equal(forced.generated, true);
  assert.equal((await readBundle(root, f.slug)).generatedAt, "2030-01-01T00:00:00.000Z");
  assert.equal(
    (await readBundle(root, f.slug)).bundleId,
    first.bundleId,
    "the same state keeps the same fingerprint",
  );
});

test("a hand-edited or touched bundle does not read as current", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish();
  await f.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: f.slug, settings, now: at });

  const paths = releaseBundlePaths(root, f.slug);

  // Freshness is a fingerprint comparison, not a timestamp check.
  const bundle = await readBundle(root, f.slug);
  await writeFile(
    paths.json,
    JSON.stringify({ ...bundle, bundleId: "f".repeat(64) }, null, 2),
  );
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "outdated");

  // Malformed JSON reads as no bundle rather than as an error.
  await writeFile(paths.json, "{ not json");
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "missing");
});

test("a half-updated pair is detected", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish();
  await f.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: f.slug, settings, now: at });

  const paths = releaseBundlePaths(root, f.slug);

  // The two files cannot be renamed into place together, so disagreement
  // between them has to read as outdated rather than as current.
  await writeFile(paths.markdown, "# Stale\n\nbundle `abcdefabcdef`\n");
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "outdated");

  await rm(paths.markdown, { force: true });
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "outdated");

  await generateReleaseBundle({ slug: f.slug, settings, now: at });
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "current");
});

/* ------------------------------------------------------------------ *
 * Publication
 * ------------------------------------------------------------------ */

test("a failed publication preserves the previous bundle and leaves no temps", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish();
  await f.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: f.slug, settings, now: at });

  const good = {
    json: await readFile(path.join(root, f.slug, RELEASE_JSON_FILENAME), "utf8"),
    markdown: await readMarkdown(root, f.slug),
  };

  // Make the folder unwritable so the replacement genuinely cannot be staged.
  const folder = path.join(root, f.slug);
  await execFileAsync("chmod", ["500", folder]);
  t.after(() => execFileAsync("chmod", ["700", folder]).catch(() => undefined));

  await assert.rejects(() =>
    generateReleaseBundle({ slug: f.slug, settings, force: true, now: at }),
  );

  await execFileAsync("chmod", ["700", folder]);

  assert.equal(
    await readFile(path.join(root, f.slug, RELEASE_JSON_FILENAME), "utf8"),
    good.json,
    "the previous bundle is intact",
  );
  assert.equal(await readMarkdown(root, f.slug), good.markdown);
  assert.deepEqual(await temps(folder), [], "no staging files remain");
});

test("bundle paths cannot escape the destination", async (t) => {
  const root = await destination(t);

  for (const folder of ["../escape", "..", ".", "a/b"]) {
    assert.throws(() => releaseBundlePaths(root, folder));
  }

  const paths = releaseBundlePaths(root, "Ghetto Geek");
  assert.equal(paths.json, path.join(root, "Ghetto Geek", RELEASE_JSON_FILENAME));
  assert.equal(
    paths.markdown,
    path.join(root, "Ghetto Geek", RELEASE_MARKDOWN_FILENAME),
  );
});

test("an unrenderable track is reported rather than described", async (t) => {
  // No cover or audio, and metadata that never validates.
  const f = await fixture(t, { bpm: "not a number" });
  const root = await destination(t);

  const state = await releaseBundleState(f.slug, settingsFor(root));
  assert.equal(state.freshness, "missing");
  assert.ok(state.problem);

  const result = await generateReleaseBundle({
    slug: f.slug,
    settings: settingsFor(root),
    now: at,
  });
  assert.equal(result.generated, false);
  assert.ok(result.problem);
  assert.deepEqual(await readdir(root), [], "nothing was written");
});

test("two concurrent generations for one track converge", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish();
  await f.deliver("youtube-16x9", root);

  // The document is a pure function of what is on disk, so racing generators
  // write the same bytes and whichever renames last is still correct.
  const results = await Promise.all([
    generateReleaseBundle({ slug: f.slug, settings, force: true, now: at }),
    generateReleaseBundle({ slug: f.slug, settings, force: true, now: at }),
    generateReleaseBundle({ slug: f.slug, settings, force: true, now: at }),
  ]);

  assert.deepEqual(
    results.map((result) => result.generated),
    [true, true, true],
  );
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "current");
  assert.deepEqual(await temps(path.join(root, f.slug)), []);

  const folder = await readdir(path.join(root, f.slug));
  assert.deepEqual(folder.sort(), [
    RELEASE_JSON_FILENAME,
    RELEASE_MARKDOWN_FILENAME,
    `${f.slug}-youtube-16x9.mp4`,
  ].sort());
});

/* ------------------------------------------------------------------ *
 * Atomicity
 * ------------------------------------------------------------------ */

test("neither file is ever observed partially written", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9", "square-1x1"] });
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish("youtube-16x9");
  await f.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: f.slug, settings, now: at });

  const paths = releaseBundlePaths(root, f.slug);
  const seen = { json: new Set<string>(), markdown: new Set<string>() };
  const sampling = setInterval(() => {
    for (const [key, file] of [
      ["json", paths.json],
      ["markdown", paths.markdown],
    ] as const) {
      try {
        seen[key].add(readFileSync(file, "utf8"));
      } catch {
        // Absent is impossible here; a rename never exposes a gap.
      }
    }
  }, 1);

  try {
    // Publish a materially different bundle while sampling both files.
    await f.publish("square-1x1");
    await f.deliver("square-1x1", root);
    await generateReleaseBundle({ slug: f.slug, settings, now: at });
  } finally {
    clearInterval(sampling);
  }

  // Every sample must be a complete document, never a prefix of one.
  for (const sample of seen.json) {
    assert.doesNotThrow(() => JSON.parse(sample), "release.json is always valid");
  }
  for (const sample of seen.markdown) {
    assert.match(sample, /bundle `[0-9a-f]{12}`\n$/, "release.md is always whole");
  }
  assert.deepEqual(await temps(path.join(root, f.slug)), []);
});

/* ------------------------------------------------------------------ *
 * Catalogue
 * ------------------------------------------------------------------ */

test("a catalogue run writes only what is missing or outdated", async (t) => {
  const { planReleaseBundles, generatePlannedBundles } = await import(
    "../server/services/releaseBundlePlan.ts"
  );
  const settled = await setup(t, { exportPresets: ["youtube-16x9"] });
  const fresh = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root);

  await settled.publish();
  await settled.deliver("youtube-16x9", root);
  await generateReleaseBundle({ slug: settled.slug, settings, now: at });
  const before = await readFile(
    path.join(root, settled.slug, RELEASE_JSON_FILENAME),
    "utf8",
  );

  await fresh.publish();
  await fresh.deliver("youtube-16x9", root);

  const plan = await planReleaseBundles({ settings });
  assert.ok(plan.current.some((state) => state.slug === settled.slug));
  assert.ok(plan.missing.some((state) => state.slug === fresh.slug));

  const results = await generatePlannedBundles(plan, { settings });
  const written = results.filter((result) => result.generated).map((r) => r.slug);

  assert.ok(written.includes(fresh.slug));
  assert.equal(
    written.includes(settled.slug),
    false,
    "a current bundle is left exactly as it is",
  );
  assert.equal(
    await readFile(path.join(root, settled.slug, RELEASE_JSON_FILENAME), "utf8"),
    before,
  );
});

test("one track failing does not stop the rest of the catalogue", async (t) => {
  const { planReleaseBundles, generatePlannedBundles } = await import(
    "../server/services/releaseBundlePlan.ts"
  );
  const broken = await setup(t, { exportPresets: ["youtube-16x9"] });
  const fine = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root);

  for (const track of [broken, fine]) {
    await track.publish();
    await track.deliver("youtube-16x9", root);
  }

  // One folder that cannot be written to.
  const folder = path.join(root, broken.slug);
  await execFileAsync("chmod", ["500", folder]);
  t.after(() => execFileAsync("chmod", ["700", folder]).catch(() => undefined));

  const plan = await planReleaseBundles({ settings });
  const results = await generatePlannedBundles(plan, { settings });

  await execFileAsync("chmod", ["700", folder]);

  const byslug = new Map(results.map((result) => [result.slug, result]));
  assert.equal(byslug.get(broken.slug)?.generated, false);
  assert.ok(byslug.get(broken.slug)?.problem);
  assert.equal(
    byslug.get(fine.slug)?.generated,
    true,
    "the rest of the catalogue still gets bundles",
  );
});

test("a track with no destination is set aside, not counted as work", async (t) => {
  const { planReleaseBundles } = await import(
    "../server/services/releaseBundlePlan.ts"
  );
  await setup(t);

  const plan = await planReleaseBundles({ settings: settingsFor(null) });

  assert.equal(plan.root, null);
  assert.deepEqual(plan.missing, []);
  assert.deepEqual(plan.outdated, []);
  assert.ok(plan.unavailable.length >= 1);
  assert.equal(plan.unavailable[0].freshness, "not_configured");
});

/* ------------------------------------------------------------------ *
 * Races
 * ------------------------------------------------------------------ */

test("metadata changing mid-generation leaves a consistent, self-describing bundle", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish();
  await f.deliver("youtube-16x9", root);

  // The edit lands while generation is between reading state and writing.
  const original = JSON.parse(await readFile(f.metadataPath, "utf8"));
  const edited = generateReleaseBundle({
    slug: f.slug,
    settings,
    now: () => {
      writeFileSync(
        f.metadataPath,
        JSON.stringify({ ...original, title: "Renamed mid-generation" }),
      );
      return AT;
    },
  });

  await edited;

  // Whatever it wrote describes one coherent state and carries that state's
  // own id — so the newer metadata simply makes it outdated, and regenerating
  // is what catches up. A bundle is never left claiming to be current when it
  // is not.
  const bundle = await readBundle(root, f.slug);
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(bundle)));
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "outdated");

  await generateReleaseBundle({ slug: f.slug, settings, now: at });
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "current");
  assert.equal((await readBundle(root, f.slug)).track.title, "Renamed mid-generation");
});

test("the destination disappearing mid-generation fails without leaving a bundle", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish();
  await f.deliver("youtube-16x9", root);

  await assert.rejects(() =>
    generateReleaseBundle({
      slug: f.slug,
      settings,
      now: () => {
        // Gone by the time anything is written.
        rmSync(root, { recursive: true, force: true });
        return AT;
      },
    }),
  );

  assert.equal(existsSync(path.join(root, f.slug, RELEASE_JSON_FILENAME)), false);
});

/* ------------------------------------------------------------------ *
 * Auto-update after delivery
 * ------------------------------------------------------------------ */

test("auto-update is off unless switched on", async (t) => {
  const { updateReleaseBundleAfterDelivery } = await import(
    "../services/delivery/autoReleaseBundle.ts"
  );
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);

  await f.publish();
  await f.deliver("youtube-16x9", root);

  assert.deepEqual(
    await updateReleaseBundleAfterDelivery([f.slug], settingsFor(root, false)),
    [],
    "nothing is written when it was not asked for",
  );
  assert.equal(
    existsSync(path.join(root, f.slug, RELEASE_JSON_FILENAME)),
    false,
  );
});

test("auto-update writes one bundle per track after a delivery", async (t) => {
  const { updateReleaseBundleAfterDelivery } = await import(
    "../services/delivery/autoReleaseBundle.ts"
  );
  const f = await setup(t, { exportPresets: ["youtube-16x9", "square-1x1"] });
  const root = await destination(t);
  const settings = settingsFor(root, true);

  await f.publish("youtube-16x9");
  await f.publish("square-1x1");
  await f.deliver("youtube-16x9", root);
  await f.deliver("square-1x1", root);

  // Two formats delivered is still one bundle.
  const results = await updateReleaseBundleAfterDelivery(
    [f.slug, f.slug],
    settings,
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].generated, true);
  assert.equal((await releaseBundleState(f.slug, settings)).freshness, "current");
  assert.equal((await readBundle(root, f.slug)).deliveries.length, 2);
});

test("a bundle that cannot be written never fails the delivery", async (t) => {
  const { updateReleaseBundleAfterDelivery } = await import(
    "../services/delivery/autoReleaseBundle.ts"
  );
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root, true);

  await f.publish();
  const delivery = await f.deliver("youtube-16x9", root);
  assert.equal(delivery.status, "delivered");

  const folder = path.join(root, f.slug);
  await execFileAsync("chmod", ["500", folder]);
  t.after(() => execFileAsync("chmod", ["700", folder]).catch(() => undefined));

  const results = await updateReleaseBundleAfterDelivery([f.slug], settings);

  await execFileAsync("chmod", ["700", folder]);

  assert.equal(results.length, 1);
  assert.equal(results[0].generated, false);
  assert.ok(results[0].problem, "the failure is reported, not thrown");

  // And what was delivered is exactly where it was.
  assert.equal(
    existsSync(path.join(folder, `${f.slug}-youtube-16x9.mp4`)),
    true,
  );
});
