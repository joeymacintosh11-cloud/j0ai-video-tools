import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { DELIVERY_LOG_SCHEMA_VERSION } from "../core/domain/delivery/deliveryHistory.ts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import type { RenderPresetId } from "../core/domain/video/renderPresets.ts";
import { appendDeliveryLogEvent } from "../services/delivery/deliveryHistoryLog.ts";
import type { DeliverySettings } from "../services/delivery/deliverySettings.ts";
import { contentLibraryPath, readContentLibrary } from "../services/library/contentLibraryLog.ts";
import {
  adoptExistingExports,
  captureExportBefore,
  libraryRecordIdFor,
  publishRecordedExport,
  recordPublishedExport,
  trackSnapshotFromProps,
} from "../services/library/recordExport.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { fingerprintInputs, readExportManifest } from "../services/tracks/exportManifest.ts";
import { trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { getContentLibraryRecord, queryContentLibrary } from "../services/workflows/contentLibrary.ts";
import { fixture } from "./fixtures.mts";

/**
 * The content library end to end, through the real publish path: a real
 * fixture track, the real `publishExport` (with a stand-in producer instead of
 * Chromium), real manifests and real freshness. Each test records into its own
 * temp library, so nothing here touches the repository's real
 * out/.content-library/.
 */

const NO_DESTINATION: DeliverySettings = { schemaVersion: 1, root: null, autoDeliver: false, autoUpdateReleaseBundle: false };

const setup = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const f = await fixture(t, extra);
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));
  const root = await mkdtemp(path.join(tmpdir(), "toshi-library-record-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const props = async () =>
    buildTrackProps({
      slug: f.slug,
      metadata: parseTrackMetadata(JSON.parse(await readFile(f.metadata, "utf8")), "fixture"),
      analysisAvailable: true,
    });

  const publish = async (
    presetId: RenderPresetId,
    options: { content?: string; jobId?: string | null; produce?: (file: string) => Promise<void>; checkCancelled?: () => void } = {},
  ) => {
    const current = await props();
    return publishRecordedExport({
      slug: f.slug,
      presetId,
      inputs: fingerprintInputs(current, presetId),
      track: trackSnapshotFromProps(f.slug, current),
      jobId: options.jobId ?? null,
      root,
      checkCancelled: options.checkCancelled,
      produce:
        options.produce ??
        (async (file) => {
          await writeFile(file, options.content ?? `video ${randomUUID()}`);
        }),
    });
  };

  return { f, root, publish, props };
};

/* ------------------------------------------------------------------ *
 * A completed export is recorded; 18. a failed or cancelled one is not
 * ------------------------------------------------------------------ */

test("a completed export is recorded as an original, with its job id and the manifest's own identity", async (t) => {
  const { f, root, publish } = await setup(t);
  const outcome = await publish("youtube-16x9", { jobId: "job-1" });
  assert.equal(outcome.appended, true);

  const [record] = readContentLibrary(root).records;
  const { manifest } = readExportManifest(trackOutputLocation(f.slug, "youtube-16x9").manifest, f.slug, "youtube-16x9");
  assert.ok(manifest);
  assert.equal(record.exportKind, "original");
  assert.equal(record.replaces, null);
  assert.equal(record.renderJobId, "job-1");
  assert.equal(record.source, "render");
  assert.equal(record.generatedAt, manifest.renderedAt);
  assert.equal(record.manifest.inputFingerprint, manifest.inputFingerprint);
  assert.deepEqual(record.output, { path: `out/${f.slug}/youtube-16x9.mp4`, ...manifest.output });
  assert.equal(record.recordId, libraryRecordIdFor(f.slug, "youtube-16x9", manifest));
  assert.equal(record.track.title, "Fixture");
  assert.equal(record.preset.id, "youtube-16x9");
});

test("a failed render records nothing and leaves earlier history untouched", async (t) => {
  const { root, publish } = await setup(t);
  await publish("youtube-16x9");
  const before = await readFile(contentLibraryPath(root), "utf8");

  await assert.rejects(
    publish("youtube-16x9", { produce: async () => { throw new Error("renderMedia() failed"); } }),
    /renderMedia\(\) failed/,
  );
  assert.equal(await readFile(contentLibraryPath(root), "utf8"), before);
});

test("a cancelled render records nothing", async (t) => {
  const { root, publish } = await setup(t);
  let checks = 0;
  await assert.rejects(
    publish("vertical-9x16", {
      // Cancelled after the frames were produced, before publication.
      checkCancelled: () => {
        checks += 1;
        if (checks >= 2) throw new Error("renderMedia() got cancelled");
      },
    }),
    /got cancelled/,
  );
  assert.equal(readContentLibrary(root).status, "missing");
});

test("recording never fails the render: an unwritable library is reported and the export is still published", async (t) => {
  const { f, root, props } = await setup(t);
  const blocked = path.join(root, "not-a-directory");
  await writeFile(blocked, "x");
  const current = await props();

  const outcome = await publishRecordedExport({
    slug: f.slug,
    presetId: "square-1x1",
    inputs: fingerprintInputs(current, "square-1x1"),
    track: trackSnapshotFromProps(f.slug, current),
    jobId: null,
    root: blocked,
    produce: async (file) => writeFile(file, "published anyway"),
  });

  assert.equal(outcome.appended, false);
  assert.ok(outcome.problem);
  assert.equal(await readFile(trackOutputLocation(f.slug, "square-1x1").path, "utf8"), "published anyway");
});

/* ------------------------------------------------------------------ *
 * Re-exports create new records and never mutate the original
 * ------------------------------------------------------------------ */

test("a re-export appends a new record naming exactly what it replaced and why; the original is untouched", async (t) => {
  const { f, root, publish } = await setup(t);
  await publish("youtube-16x9", { content: "first" });
  const original = readContentLibrary(root).records[0];
  const originalLine = (await readFile(contentLibraryPath(root), "utf8")).split("\n")[0];

  await writeFile(f.cover, "a different cover");
  await publish("youtube-16x9", { content: "second" });

  const text = await readFile(contentLibraryPath(root), "utf8");
  assert.equal(text.split("\n")[0], originalLine, "the original record's bytes never change");
  const [, reexport] = readContentLibrary(root).records;
  assert.equal(reexport.exportKind, "reexport");
  assert.deepEqual(reexport.replaces, {
    recordId: original.recordId,
    generatedAt: original.generatedAt,
    inputFingerprint: original.manifest.inputFingerprint,
    changed: ["cover_changed"],
  });
  assert.notEqual(reexport.recordId, original.recordId);
});

test("an export that replaced a file from before the library is a re-export with no replaced record", async (t) => {
  const { f, root, publish } = await setup(t);
  const output = trackOutputLocation(f.slug, "youtube-16x9");
  await mkdir(output.dir, { recursive: true });
  await writeFile(output.path, "an old render with no manifest");

  await publish("youtube-16x9");
  const [record] = readContentLibrary(root).records;
  assert.equal(record.exportKind, "reexport");
  assert.deepEqual(record.replaces, { recordId: null, generatedAt: null, inputFingerprint: null, changed: [] });
});

test("a repeated completion step records one export once", async (t) => {
  const { f, root, props } = await setup(t);
  const current = await props();
  const before = captureExportBefore(f.slug, "youtube-16x9");
  await publishExport(f.slug, "youtube-16x9", fingerprintInputs(current, "youtube-16x9"), async (file) => writeFile(file, "v"));
  const { manifest } = readExportManifest(trackOutputLocation(f.slug, "youtube-16x9").manifest, f.slug, "youtube-16x9");
  const input = { slug: f.slug, presetId: "youtube-16x9" as const, track: trackSnapshotFromProps(f.slug, current), jobId: "job-x", before, published: manifest!, root };

  const first = await recordPublishedExport(input);
  const retried = await recordPublishedExport(input);
  assert.equal(first.appended, true);
  assert.deepEqual([retried.appended, retried.duplicate], [false, true]);
  assert.equal(readContentLibrary(root).records.length, 1);
});

/* ------------------------------------------------------------------ *
 * Batch-style multi-format renders, and the query service
 * ------------------------------------------------------------------ */

test("each format a batch renders is recorded independently, with its own job", async (t) => {
  const { f, root, publish } = await setup(t);
  await publish("youtube-16x9", { jobId: "job-a" });
  await publish("square-1x1", { jobId: "job-b" });

  const result = await queryContentLibrary({ root, settings: NO_DESTINATION, filter: { track: f.slug } });
  assert.deepEqual(
    result.entries.map((entry) => [entry.record.preset.id, entry.record.renderJobId, entry.status]).sort(),
    [["square-1x1", "job-b", "current"], ["youtube-16x9", "job-a", "current"]],
  );
  assert.deepEqual(
    result.formats?.map((format) => [format.presetId, format.versions]),
    [["youtube-16x9", 1], ["vertical-9x16", 0], ["square-1x1", 1]],
  );

  const byJob = await queryContentLibrary({ root, settings: NO_DESTINATION, filter: { renderJobId: "job-b" } });
  assert.deepEqual(byJob.entries.map((entry) => entry.record.preset.id), ["square-1x1"]);
});

test("status comes from the live manifests, with no delivery destination or release bundle needed", async (t) => {
  const { f, root, publish } = await setup(t);
  await publish("youtube-16x9");
  await publish("youtube-16x9");

  const fresh = await queryContentLibrary({ root, settings: NO_DESTINATION, filter: { track: f.slug } });
  assert.equal(fresh.deliveries, "not_configured");
  assert.deepEqual(fresh.entries.map((entry) => entry.status), ["current", "superseded"]);
  assert.ok(fresh.entries.every((entry) => entry.deliveries === null));

  // A rendered field changing makes the version on disk stale — history
  // itself is never rewritten to say so.
  const before = await readFile(contentLibraryPath(root), "utf8");
  const metadata = JSON.parse(await readFile(f.metadata, "utf8"));
  await writeFile(f.metadata, JSON.stringify({ ...metadata, bpm: 123 }));
  const stale = await queryContentLibrary({ root, settings: NO_DESTINATION, filter: { track: f.slug } });
  assert.deepEqual(stale.entries.map((entry) => entry.status), ["stale", "superseded"]);
  assert.equal(await readFile(contentLibraryPath(root), "utf8"), before);

  // The file vanishing makes it missing.
  await rm(trackOutputLocation(f.slug, "youtube-16x9").path);
  const missing = await queryContentLibrary({ root, settings: NO_DESTINATION, filter: { track: f.slug, status: "missing" } });
  assert.equal(missing.entries.length, 1);
});

test("deliveries are attributed per version when a destination is configured", async (t) => {
  const { f, root, publish } = await setup(t);
  await publish("youtube-16x9");
  const [record] = readContentLibrary(root).records;

  const destination = realpathSync(await mkdtemp(path.join(tmpdir(), "toshi-library-destination-")));
  t.after(() => rm(destination, { recursive: true, force: true }));
  const appended = await appendDeliveryLogEvent(destination, {
    schemaVersion: DELIVERY_LOG_SCHEMA_VERSION,
    eventId: "event-1",
    kind: "delivery",
    source: "delivery",
    deliveredAt: new Date(Date.parse(record.generatedAt) + 1000).toISOString(),
    track: { slug: f.slug, title: "Fixture", artist: "Toshi", key: "F Minor", bpm: 100 },
    preset: record.preset,
    path: `${f.slug}/${f.slug}-youtube-16x9.mp4`,
    bytes: record.output.bytes,
    exportFingerprint: record.manifest.inputFingerprint,
    deliveryId: "delivery-1",
  });
  assert.equal(appended.appended, true);

  const result = await queryContentLibrary({
    root,
    settings: { ...NO_DESTINATION, root: destination },
    filter: { track: f.slug },
  });
  assert.equal(result.deliveries, "available");
  assert.equal(result.entries[0].deliveries?.count, 1);
});

test("inspecting a record returns every version of its format and says whether it can be re-exported", async (t) => {
  const { f, root, publish } = await setup(t);
  await publish("youtube-16x9");
  await publish("youtube-16x9");
  const [first, second] = readContentLibrary(root).records;

  const superseded = await getContentLibraryRecord(first.recordId, { root, settings: NO_DESTINATION });
  assert.equal(superseded.entry.status, "superseded");
  assert.equal(superseded.entry.supersededBy, second.recordId);
  assert.deepEqual(superseded.versions.map((v) => v.record.recordId), [first.recordId, second.recordId]);
  assert.equal(superseded.reexport.allowed, false);
  assert.match(superseded.reexport.reason ?? "", /current version/);

  const current = await getContentLibraryRecord(second.recordId, { root, settings: NO_DESTINATION });
  assert.equal(current.entry.status, "current");
  assert.equal(current.entry.record.track.slug, f.slug);

  await assert.rejects(getContentLibraryRecord("0".repeat(32), { root }), /No content library record/);
});

/* ------------------------------------------------------------------ *
 * Adopting exports that predate the library
 * ------------------------------------------------------------------ */

test("existing exports can be adopted once, honestly marked, skipping files that no longer match their manifest", async (t) => {
  const { f, root, props } = await setup(t);
  const current = await props();
  for (const presetId of ["youtube-16x9", "square-1x1"] as const) {
    await publishExport(f.slug, presetId, fingerprintInputs(current, presetId), async (file) => writeFile(file, presetId));
  }
  // Edited after publishing: the manifest no longer describes this file.
  await appendFile(trackOutputLocation(f.slug, "square-1x1").path, " edited");
  assert.ok((await stat(trackOutputLocation(f.slug, "square-1x1").path)).size > 0);

  const first = await adoptExistingExports({ root, slugs: [f.slug] });
  assert.equal(first.adopted, 1);
  assert.deepEqual(first.skipped.map((s) => [s.presetId, s.reason]), [["square-1x1", "the file no longer matches its manifest"]]);

  const [adopted] = readContentLibrary(root).records;
  assert.deepEqual([adopted.source, adopted.exportKind, adopted.renderJobId, adopted.replaces], ["adopted", null, null, null]);

  const again = await adoptExistingExports({ root, slugs: [f.slug] });
  assert.deepEqual([again.adopted, again.alreadyRecorded], [0, 1]);
  assert.equal(readContentLibrary(root).records.length, 1);
});

test("adopting a track that does not exist is a harmless no-op", async (t) => {
  const { root } = await setup(t);
  const result = await adoptExistingExports({ root, slugs: ["no-such-track-anywhere"] });
  assert.equal(result.adopted, 0);
  assert.deepEqual(result.skipped, []);
});
