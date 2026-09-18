import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { createTrack } from "../services/tracks/createTrack.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { trackLocations } from "../services/tracks/trackLocations.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import {
  coerceMetadataDraft,
  createDefaultMetadata,
  serializeTrackMetadata,
  validateTrackMetadata,
} from "../src/domain/tracks/metadata.ts";
import {
  RENDER_PRESET_IDS,
  resolveExportPresets,
} from "../src/domain/video/renderPresets.ts";
import { fixture } from "./fixtures.mts";
import type { TestContext } from "node:test";

/**
 * Declared export intent: which formats a track says it ships in.
 *
 * The rule that everything else rests on is that an undeclared track means
 * "every format" — the behaviour from before this field existed — so no
 * metadata.json on disk has to be migrated for the feature to work.
 */

const base = {
  title: "Fixture",
  artist: "Toshi",
  key: "F Minor",
  bpm: 100,
};

const validated = (raw: Record<string, unknown>) =>
  validateTrackMetadata(raw, "metadata.json");

test("a declared list is accepted and stored in canonical order", () => {
  const { metadata, issues } = validated({
    ...base,
    exportPresets: ["square-1x1", "youtube-16x9"],
  });

  assert.deepEqual(issues, []);
  assert.deepEqual(metadata?.exportPresets, ["youtube-16x9", "square-1x1"]);
});

test("an unknown format is refused, and says which ones exist", () => {
  const { metadata, issues } = validated({ ...base, exportPresets: ["tiktok"] });

  assert.equal(metadata, null);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, "METADATA_INVALID");
  assert.match(issues[0].message, /unknown format "tiktok"/);
  assert.match(issues[0].message, /youtube-16x9, vertical-9x16, square-1x1/);
});

test("a repeated format is refused rather than quietly collapsed", () => {
  const { metadata, issues } = validated({
    ...base,
    exportPresets: ["square-1x1", "square-1x1"],
  });

  assert.equal(metadata, null);
  assert.match(issues[0].message, /more than once/);
});

test("an empty list is refused, and points at leaving the field out", () => {
  const { metadata, issues } = validated({ ...base, exportPresets: [] });

  assert.equal(metadata, null);
  assert.match(issues[0].message, /at least one format/);
  assert.match(issues[0].message, /left out entirely/);
});

test("a list that is not an array is refused", () => {
  const { metadata } = validated({ ...base, exportPresets: "youtube-16x9" });

  assert.equal(metadata, null);
});

test("every problem in one list is reported, not only the first", () => {
  const { issues } = validated({
    ...base,
    exportPresets: ["tiktok", "square-1x1", "square-1x1"],
  });

  assert.equal(issues.length, 2, "an unknown id and a repeat, both reported");
});

test("metadata without the field stays valid, and means every format", () => {
  const { metadata, issues } = validated(base);

  assert.deepEqual(issues, []);
  assert.equal(metadata?.exportPresets, undefined, "undeclared, not defaulted");
  assert.deepEqual(resolveExportPresets(metadata?.exportPresets), [
    ...RENDER_PRESET_IDS,
  ]);
});

test("a declared list resolves to itself, in canonical order", () => {
  assert.deepEqual(resolveExportPresets(["square-1x1", "youtube-16x9"]), [
    "youtube-16x9",
    "square-1x1",
  ]);
});

test("serialization omits the field entirely when it is undeclared", () => {
  const withoutIntent = serializeTrackMetadata({ ...base, subtitle: "s" });
  const withIntent = serializeTrackMetadata({
    ...base,
    exportPresets: ["vertical-9x16"],
  });

  assert.equal(
    withoutIntent.includes("exportPresets"),
    false,
    "an undeclared track keeps a file with no exportPresets key",
  );
  assert.match(withIntent, /"exportPresets": \[\n\s+"vertical-9x16"\n\s+\]/);
  assert.ok(withIntent.endsWith("]\n}\n"), "intent is written last");
});

test("a draft coerces what it can and drops what it cannot", () => {
  const draft = coerceMetadataDraft({
    ...base,
    exportPresets: ["nonsense", "square-1x1", "youtube-16x9"],
  });

  assert.deepEqual(draft?.exportPresets, ["youtube-16x9", "square-1x1"]);
  assert.equal(
    coerceMetadataDraft({ ...base, exportPresets: 7 })?.exportPresets,
    undefined,
  );
});

test("a new track declares the default format, so its intent is never a guess", async (t) => {
  assert.deepEqual(createDefaultMetadata("X").exportPresets, ["youtube-16x9"]);

  const title = `Zz Test ${randomUUID()}`;
  const { slug } = await createTrack(title, ["vertical-9x16", "square-1x1"]);
  t.after(() =>
    rm(trackLocations(slug).trackDir, { recursive: true, force: true }),
  );

  const written = JSON.parse(
    await readFile(trackLocations(slug).metadata, "utf-8"),
  );

  assert.deepEqual(written.exportPresets, ["vertical-9x16", "square-1x1"]);
});

test("a patch that does not name intent leaves an undeclared track undeclared", async (t) => {
  const f = await fixture(t);

  await updateTrackMetadata(f.slug, { bpm: 120 });

  const written = JSON.parse(await readFile(f.metadata, "utf-8"));

  assert.equal(written.bpm, 120);
  assert.equal(
    "exportPresets" in written,
    false,
    "editing one field must not invent an intent the user never chose",
  );
});

test("a patch can declare intent, and a later patch keeps it", async (t) => {
  const f = await fixture(t);

  await updateTrackMetadata(f.slug, { exportPresets: ["square-1x1"] });
  await updateTrackMetadata(f.slug, { bpm: 90 });

  const written = JSON.parse(await readFile(f.metadata, "utf-8"));

  assert.deepEqual(written.exportPresets, ["square-1x1"]);
  assert.equal(written.bpm, 90);
});

test("an invalid intent is refused without touching the file", async (t) => {
  const f = await fixture(t, { exportPresets: ["youtube-16x9"] });
  const before = await readFile(f.metadata, "utf-8");

  await assert.rejects(
    () =>
      updateTrackMetadata(f.slug, {
        exportPresets: ["square-1x1", "square-1x1"] as never,
      }),
    { code: "METADATA_INVALID" },
  );

  assert.equal(await readFile(f.metadata, "utf-8"), before);
});

test("intent is still protected by the revision precondition", async (t) => {
  const f = await fixture(t, { exportPresets: ["youtube-16x9"] });
  const stale = (await inspectTrack(f.slug)).metadataRevision;
  assert.ok(stale);

  await updateTrackMetadata(f.slug, { exportPresets: ["square-1x1"] }, stale);

  await assert.rejects(
    () =>
      updateTrackMetadata(f.slug, { exportPresets: ["vertical-9x16"] }, stale),
    { code: "METADATA_CONFLICT" },
  );

  const written = JSON.parse(await readFile(f.metadata, "utf-8"));
  assert.deepEqual(written.exportPresets, ["square-1x1"]);
});

test("a broken intent on disk makes the track invalid, and says why", async (t: TestContext) => {
  const f = await fixture(t, { exportPresets: ["youtube-16x9", "nope"] });
  const inspection = await inspectTrack(f.slug);

  // The fixture has no cover or audio, so overall validity would be false
  // either way; what this asserts is that the intent itself is what broke.
  assert.equal(inspection.metadata, null);
  assert.match(
    inspection.validation.errors.map((issue) => issue.message).join(" "),
    /unknown format "nope"/,
  );

  // The draft still prefills an editor with what could be read.
  assert.deepEqual(inspection.metadataDraft?.exportPresets, ["youtube-16x9"]);

  await writeFile(
    f.metadata,
    JSON.stringify({ ...base, exportPresets: ["youtube-16x9"] }),
  );

  const repaired = await inspectTrack(f.slug);

  assert.deepEqual(repaired.metadata?.exportPresets, ["youtube-16x9"]);
  assert.equal(
    repaired.validation.errors.some((issue) => issue.code === "METADATA_INVALID"),
    false,
  );
});
