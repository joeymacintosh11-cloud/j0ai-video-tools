import assert from "node:assert/strict";
import { chmodSync, realpathSync } from "node:fs";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import {
  deliveryReceiptPath,
  readDeliveryReceipt,
} from "../services/delivery/deliveryReceipt.ts";
import {
  assertDeliveryRoot,
  DELIVERY_OFF,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "../services/delivery/deliverySettings.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { trackOutputLocation } from "../services/tracks/trackLocations.ts";
import {
  planDeliveries,
  deliverPlanned,
} from "../server/services/deliveryPlan.ts";
import {
  assertDeliveryFolder,
  deliveryRelativePath,
} from "../src/domain/delivery/deliveryPaths.ts";
import { parseTrackMetadata } from "../src/domain/tracks/metadata.ts";
import type { RenderPresetId } from "../src/domain/video/renderPresets.ts";
import { fixture } from "./fixtures.mts";

/**
 * Local export delivery.
 *
 * Real directories in a throwaway temp root, because the behaviour being
 * checked is filesystem behaviour: an atomic rename, a preserved previous copy,
 * a cleaned-up temp file. Settings are passed in explicitly, so no test ever
 * reads or writes the project's own delivery.local.json.
 */

const destination = async (t: TestContext) => {
  // Resolved, because a configured root is stored resolved — on macOS the temp
  // directory is reached through a symlink, so an unresolved path here would be
  // comparing against something the code never stores.
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "toshi-delivery-")));
  t.after(async () => {
    // Re-open permissions first: one test makes a folder read-only.
    try {
      chmodSync(root, 0o700);
    } catch {
      // Already writable.
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
};

const settingsFor = (root: string | null, autoDeliver = false): DeliverySettings => ({
  schemaVersion: 1,
  root,
  autoDeliver,
});

/** A track with a real published export, ready to deliver. */
const setup = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const f = await fixture(t, extra);
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));

  const metadata = parseTrackMetadata(
    JSON.parse(await readFile(f.metadata, "utf8")),
    "fixture",
  );
  const props = buildTrackProps({
    slug: f.slug,
    metadata,
    analysisAvailable: true,
  });

  const publish = (
    presetId: RenderPresetId = "youtube-16x9",
    body = "successful video",
  ) =>
    publishExport(
      f.slug,
      presetId,
      fingerprintInputs(props, presetId),
      async (file) => {
        await writeFile(file, body);
      },
    );

  const facts = (presetId: RenderPresetId = "youtube-16x9") =>
    trackExportCoverage(f.slug, metadata).find(
      (entry) => entry.presetId === presetId,
    )!;

  return { ...f, metadata, props, publish, facts };
};

const files = async (root: string): Promise<string[]> => {
  const found: string[] = [];
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else found.push(relative);
    }
  };
  await walk(root, "");
  return found.sort();
};

/* ------------------------------------------------------------------ *
 * Destination resolution and path safety
 * ------------------------------------------------------------------ */

test("with no destination configured, nothing is delivered and nothing fails", async (t) => {
  const f = await setup(t);
  await f.publish();

  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: DELIVERY_OFF,
  });

  assert.equal(outcome.status, "not_configured");
  assert.equal(outcome.reason, "not_configured");
  assert.equal(outcome.destinationPath, null);

  // And the export is untouched, as it must be when delivery is simply off.
  assert.equal(f.facts().freshness, "current");
});

test("a destination must be absolute, existing, a directory and outside the project", async (t) => {
  const root = await destination(t);
  const file = path.join(root, "a-file");
  await writeFile(file, "not a directory");

  assert.equal(assertDeliveryRoot(root), root);

  for (const [value, expected] of [
    ["relative/path", /absolute path/],
    [path.join(root, "missing"), /does not exist/],
    [file, /not a folder/],
    ["", /absolute folder path/],
    [process.cwd(), /outside the project folder/],
  ] as const) {
    assert.throws(() => assertDeliveryRoot(value), expected, `rejects ${value}`);
  }
});

test("a destination that has gone away is reported, not treated as off", async (t) => {
  const root = await destination(t);
  await rm(root, { recursive: true, force: true });

  const resolved = resolveDeliveryRoot(settingsFor(root));

  assert.equal(resolved.root, null);
  assert.match(resolved.problem ?? "", /not available/);
});

test("a delivery folder cannot escape the destination", () => {
  for (const folder of [
    "../escape",
    "..",
    ".",
    "a/b",
    "a\\b",
    "/absolute",
    ".hidden",
    "trailing.",
    "",
    "   ",
    "with:colon",
  ]) {
    assert.throws(
      () => assertDeliveryFolder(folder),
      { code: "METADATA_INVALID" },
      `rejects ${JSON.stringify(folder)}`,
    );
  }

  assert.equal(assertDeliveryFolder("Ghetto Geek"), "Ghetto Geek");
  assert.equal(assertDeliveryFolder("  Padded  "), "Padded");
});

test("the delivered path is deterministic, and defaults to the slug", () => {
  assert.equal(
    deliveryRelativePath("ghetto-geek", "youtube-16x9"),
    "ghetto-geek/ghetto-geek-youtube-16x9.mp4",
  );
  assert.equal(
    deliveryRelativePath("ghetto-geek", "square-1x1", "Ghetto Geek"),
    "Ghetto Geek/ghetto-geek-square-1x1.mp4",
  );
  // Same inputs, same answer, every time.
  assert.equal(
    deliveryRelativePath("ghetto-geek", "square-1x1", "Ghetto Geek"),
    deliveryRelativePath("ghetto-geek", "square-1x1", "Ghetto Geek"),
  );
  assert.throws(() => deliveryRelativePath("../etc", "square-1x1"), {
    code: "INVALID_SLUG",
  });
});

/* ------------------------------------------------------------------ *
 * Delivering
 * ------------------------------------------------------------------ */

test("a current export is copied to the destination, leaving the original alone", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  await f.publish();

  const before = await readFile(f.facts().outputPath);
  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  assert.equal(outcome.status, "delivered");
  assert.equal(
    outcome.destinationRelativePath,
    `${f.slug}/${f.slug}-youtube-16x9.mp4`,
  );
  assert.deepEqual(await files(root), [
    `${f.slug}/${f.slug}-youtube-16x9.mp4`,
  ]);
  assert.deepEqual(
    await readFile(path.join(root, outcome.destinationRelativePath!)),
    before,
    "the delivered copy is byte-identical",
  );
  assert.deepEqual(
    await readFile(f.facts().outputPath),
    before,
    "the canonical export is never moved or altered",
  );
});

test("a track's own folder overrides the default", async (t) => {
  const f = await setup(t, { deliveryFolder: "Ghetto Geek" });
  const root = await destination(t);
  await f.publish();

  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
    metadata: f.metadata,
  });

  assert.equal(
    outcome.destinationRelativePath,
    `Ghetto Geek/${f.slug}-youtube-16x9.mp4`,
  );
});

test("the folder is read from metadata even when the caller does not pass it", async (t) => {
  const f = await setup(t, { deliveryFolder: "Ghetto Geek" });
  const root = await destination(t);
  await f.publish();

  // Omitting metadata must not quietly fall back to the slug: the folder is a
  // stored decision, not a caller's convenience.
  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  assert.equal(
    outcome.destinationRelativePath,
    `Ghetto Geek/${f.slug}-youtube-16x9.mp4`,
  );
});

test("a missing export cannot be delivered", async (t) => {
  const f = await setup(t);
  const root = await destination(t);

  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  assert.equal(outcome.status, "pending");
  assert.equal(outcome.reason, "export_missing");
  assert.deepEqual(await files(root), [], "nothing was written");
});

test("a stale export cannot be delivered", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  await f.publish();

  // Changing an input makes the published export stale.
  await writeFile(f.cover, "different cover");
  assert.equal(f.facts().freshness, "stale");

  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  assert.equal(outcome.status, "outdated");
  assert.equal(outcome.reason, "export_not_current");
  assert.deepEqual(await files(root), []);
});

test("an export with an unreadable manifest cannot be delivered", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  await f.publish();

  await writeFile(trackOutputLocation(f.slug, "youtube-16x9").manifest, "{ broken");
  assert.equal(f.facts().freshness, "stale");

  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  assert.equal(outcome.status, "outdated");
  assert.deepEqual(await files(root), []);
});

test("a failed copy keeps the previous delivered file and cleans up after itself", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  await f.publish("youtube-16x9", "version one");

  const first = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });
  assert.equal(first.status, "delivered");
  const delivered = path.join(root, first.destinationRelativePath!);
  const originalBytes = await readFile(delivered);

  // Publish a second version, then make the destination folder unwritable so
  // the copy genuinely fails at the filesystem level.
  await f.publish("youtube-16x9", "version two is longer");
  chmodSync(path.dirname(delivered), 0o500);

  const second = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  assert.equal(second.status, "failed");
  assert.equal(second.reason, "copy_failed");

  chmodSync(path.dirname(delivered), 0o700);

  assert.deepEqual(
    await readFile(delivered),
    originalBytes,
    "the previously delivered file is never replaced by a failed copy",
  );
  assert.deepEqual(
    (await readdir(path.dirname(delivered))).filter((name) =>
      name.startsWith(".deliver-"),
    ),
    [],
    "no staged temp file is left behind",
  );

  // And the canonical export is entirely unaffected by the failure.
  assert.equal(f.facts().freshness, "current");
});

test("nothing partial is left in the destination on failure", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  await f.publish();

  // Removing the canonical file after coverage was read makes the copy fail
  // part-way through the delivery rather than before it starts.
  const facts = f.facts();
  await rm(facts.outputPath, { force: true });

  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  assert.notEqual(outcome.status, "delivered");
  assert.deepEqual(
    (await files(root)).filter((name) => !name.includes(".deliver-")),
    [],
    "no half-written video is published",
  );
  assert.deepEqual(
    (await files(root)).filter((name) => name.includes(".deliver-")),
    [],
    "and no temp file survives",
  );
});

/* ------------------------------------------------------------------ *
 * Receipts and freshness
 * ------------------------------------------------------------------ */

test("delivery writes a receipt that matches the current export", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  await f.publish();

  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  const receipt = readDeliveryReceipt(f.slug, "youtube-16x9");
  assert.ok(receipt);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.slug, f.slug);
  assert.equal(receipt.presetId, "youtube-16x9");
  assert.equal(receipt.sourceFingerprint, f.facts().inputFingerprint);
  assert.equal(receipt.destinationRoot, root);
  assert.ok(Number.isFinite(Date.parse(receipt.deliveredAt)));

  const delivered = await stat(path.join(root, receipt.destinationRelativePath));
  assert.equal(receipt.bytes, delivered.size);

  // The receipt lives beside the canonical pair, not at the destination.
  assert.equal(
    path.dirname(deliveryReceiptPath(f.slug, "youtube-16x9")),
    trackOutputLocation(f.slug, "youtube-16x9").dir,
  );
  assert.equal(
    (await files(root)).some((name) => name.endsWith(".json")),
    false,
    "no bookkeeping files are dropped into the destination",
  );
});

test("a re-render leaves the delivery outdated until it is delivered again", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  const settings = settingsFor(root);
  await f.publish();

  const state = async () => {
    const plan = await planDeliveries({ slugs: [f.slug], settings });
    return plan.considered.find((target) => target.presetId === "youtube-16x9");
  };

  await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings });
  assert.equal((await state())?.status, "delivered");

  // A changed input, then a real re-publication: the export is current again
  // but the destination still holds the older one.
  await writeFile(f.cover, "new cover");
  assert.equal((await state())?.status, "outdated");
  assert.equal((await state())?.reason, "export_not_current");

  await f.publish("youtube-16x9", "second version");
  const afterRender = await state();
  assert.equal(afterRender?.status, "outdated");
  assert.equal(
    afterRender?.reason,
    "export_changed",
    "the canonical export is current, but what was delivered is not it",
  );

  await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings });
  assert.equal((await state())?.status, "delivered");
});

test("a delivered file removed or replaced at the destination is detected", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  const settings = settingsFor(root);
  await f.publish();

  const outcome = await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings,
  });
  const delivered = path.join(root, outcome.destinationRelativePath!);

  const status = async () =>
    (await planDeliveries({ slugs: [f.slug], settings })).considered.find(
      (target) => target.presetId === "youtube-16x9",
    );

  await writeFile(delivered, "someone edited this");
  assert.equal((await status())?.status, "outdated");
  assert.equal((await status())?.reason, "destination_modified");

  await rm(delivered, { force: true });
  assert.equal((await status())?.status, "outdated");
  assert.equal((await status())?.reason, "destination_missing");
});

test("changing the destination makes an existing delivery outdated", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  const elsewhere = await destination(t);
  await f.publish();

  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  const plan = await planDeliveries({
    slugs: [f.slug],
    settings: settingsFor(elsewhere),
  });
  const target = plan.considered.find(
    (entry) => entry.presetId === "youtube-16x9",
  );

  assert.equal(target?.status, "outdated");
  assert.equal(target?.reason, "destination_changed");
  assert.equal(plan.deliverable.length, 1, "it is offered for the new root");
});

test("a malformed receipt reads as never delivered rather than as an error", async (t) => {
  const f = await setup(t);
  const root = await destination(t);
  await f.publish();
  await deliverExport({
    slug: f.slug,
    presetId: "youtube-16x9",
    settings: settingsFor(root),
  });

  await writeFile(deliveryReceiptPath(f.slug, "youtube-16x9"), "{ not json");

  assert.equal(readDeliveryReceipt(f.slug, "youtube-16x9"), null);
  const plan = await planDeliveries({
    slugs: [f.slug],
    settings: settingsFor(root),
  });
  assert.equal(plan.deliverable.length, 1);
  assert.equal(plan.deliverable[0].status, "pending");
});

/* ------------------------------------------------------------------ *
 * Planning
 * ------------------------------------------------------------------ */

test("several formats of one track each deliver to their own file", async (t) => {
  const f = await setup(t, {
    exportPresets: ["youtube-16x9", "square-1x1"],
    deliveryFolder: "Multi Format",
  });
  const root = await destination(t);
  const settings = settingsFor(root);

  await f.publish("youtube-16x9");
  await f.publish("square-1x1");

  const plan = await planDeliveries({ slugs: [f.slug], settings });
  assert.deepEqual(
    plan.deliverable.map((target) => target.presetId),
    ["youtube-16x9", "square-1x1"],
    "intended formats only, in canonical order",
  );

  const outcomes = await deliverPlanned(plan, settings);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ["delivered", "delivered"],
  );
  assert.deepEqual(await files(root), [
    `Multi Format/${f.slug}-square-1x1.mp4`,
    `Multi Format/${f.slug}-youtube-16x9.mp4`,
  ]);
});

test("planning covers only a track's intended formats unless told otherwise", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root);
  await f.publish("youtube-16x9");
  await f.publish("square-1x1");

  const intent = await planDeliveries({ slugs: [f.slug], settings });
  assert.deepEqual(
    intent.considered.map((target) => target.presetId),
    ["youtube-16x9"],
  );

  const override = await planDeliveries({
    slugs: [f.slug],
    presetIds: ["square-1x1"],
    settings,
  });
  assert.deepEqual(
    override.deliverable.map((target) => target.presetId),
    ["square-1x1"],
  );
});

test("a catalogue plan covers every track and reports what cannot go", async (t) => {
  const ready = await setup(t, { exportPresets: ["youtube-16x9"] });
  const notRendered = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root);

  await ready.publish("youtube-16x9");

  const plan = await planDeliveries({ settings });

  assert.equal(plan.catalogue, true);
  assert.ok(plan.tracks >= 2);
  assert.deepEqual(
    plan.deliverable
      .filter((target) => target.slug === ready.slug)
      .map((target) => target.presetId),
    ["youtube-16x9"],
  );
  assert.deepEqual(
    plan.notCurrent
      .filter((target) => target.slug === notRendered.slug)
      .map((target) => target.freshness),
    ["missing"],
    "a track with nothing rendered is reported, not delivered",
  );
});

test("an unrenderable track is reported rather than delivered", async (t) => {
  const f = await fixture(t);
  const root = await destination(t);

  // No cover or audio, so the track is not renderable at all.
  const plan = await planDeliveries({
    slugs: [f.slug],
    settings: settingsFor(root),
  });

  assert.equal(plan.invalid.length, 1);
  assert.equal(plan.invalid[0].slug, f.slug);
  assert.deepEqual(plan.deliverable, []);
});

test("a plan with nothing to do is a successful no-op", async (t) => {
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  const root = await destination(t);
  const settings = settingsFor(root);
  await f.publish("youtube-16x9");

  await deliverPlanned(
    await planDeliveries({ slugs: [f.slug], settings }),
    settings,
  );

  const again = await planDeliveries({ slugs: [f.slug], settings });
  assert.deepEqual(again.deliverable, []);
  assert.equal(again.alreadyDelivered.length, 1);
  assert.deepEqual(await deliverPlanned(again, settings), []);
});

test("empty input is refused rather than read as the catalogue", async () => {
  await assert.rejects(() => planDeliveries({ slugs: [] }), {
    code: "INVALID_REQUEST",
  });
  await assert.rejects(
    () => planDeliveries({ slugs: ["x"], presetIds: [] }),
    { code: "INVALID_REQUEST" },
  );
});
