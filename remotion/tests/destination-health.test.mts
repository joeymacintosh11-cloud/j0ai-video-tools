import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, realpathSync, utimesSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { scanDestinationHealth } from "../server/services/destinationHealth.ts";
import {
  looksLikeManagedExportFile,
  looksLikeManagedTrackFolder,
  managedExportFilename,
} from "../core/domain/delivery/destinationHealth.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import { deliveryReceiptPath } from "../services/delivery/deliveryReceipt.ts";
import type { DeliverySettings } from "../services/delivery/deliverySettings.ts";
import { generateReleaseBundle } from "../services/delivery/releaseBundle.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import type { RenderPresetId } from "../core/domain/video/renderPresets.ts";
import { fixture } from "./fixtures.mts";

/**
 * Destination health: what physically exists at the destination, compared
 * against what current delivery receipts and release bundles say should.
 *
 * Real directories in a throwaway temp root, always delivered through the real
 * pipeline (`publishExport` + `deliverExport`) so every receipt this suite
 * starts from is genuinely internally consistent — exactly as a real one would
 * be. Drift is then created by mutating the *destination* only, never the
 * receipt, which is what the scanner exists to notice. Settings are always
 * passed in explicitly, so no test reads or writes the project's own
 * delivery.local.json.
 */

const destination = async (t: TestContext) => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "toshi-health-")));
  t.after(async () => {
    try {
      chmodSync(root, 0o700);
    } catch {
      // Already writable.
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
};

const settingsFor = (root: string | null): DeliverySettings => ({
  schemaVersion: 1,
  root,
  autoDeliver: false,
  autoUpdateReleaseBundle: false,
});

/** A track with a real published, delivered export, ready to drift. */
const setup = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const f = await fixture(t, extra);
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));

  const metadataPath = f.metadata;
  const metadata = parseTrackMetadata(
    JSON.parse(await readFile(metadataPath, "utf8")),
    "fixture",
  );
  const props = buildTrackProps({ slug: f.slug, metadata, analysisAvailable: true });

  const publish = (presetId: RenderPresetId = "youtube-16x9", body = "a finished video") =>
    publishExport(f.slug, presetId, fingerprintInputs(props, presetId), async (file) => {
      await writeFile(file, body);
    });

  const deliver = async (root: string, presetId: RenderPresetId = "youtube-16x9") => {
    const outcome = await deliverExport({ slug: f.slug, presetId, settings: settingsFor(root) });
    assert.equal(outcome.status, "delivered", outcome.message ?? "");
    return outcome;
  };

  const coverage = () => trackExportCoverage(f.slug, metadata);

  return { ...f, metadataPath, metadata, props, publish, deliver, coverage };
};

/** Every file under a root, with size — used to prove nothing was mutated. */
const snapshot = async (root: string): Promise<Map<string, number>> => {
  const found = new Map<string, number>();
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), relative);
      else if (entry.isFile()) found.set(relative, (await stat(path.join(dir, entry.name))).size);
    }
  };
  await walk(root, "");
  return found;
};

const findingCodes = (
  result: Awaited<ReturnType<typeof scanDestinationHealth>>,
  slug?: string,
): readonly string[] => {
  const track = slug === undefined ? null : result.tracks.find((t) => t.slug === slug);
  const findings = slug === undefined
    ? [...result.rootFindings, ...result.tracks.flatMap((t) => t.findings)]
    : (track?.findings ?? []);
  return findings.map((f) => f.code);
};

/* ------------------------------------------------------------------ *
 * 1-2: healthy / not configured
 * ------------------------------------------------------------------ */

test("a destination with everything delivered and bundled is reported healthy", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });

  const result = await scanDestinationHealth({ settings: settingsFor(root) });

  assert.equal(result.status, "healthy");
  assert.equal(result.counts.totalFindings, 0);
  assert.equal(result.counts.tracksWithFindings, 0);
  const track = result.tracks.find((entry) => entry.slug === f.slug);
  assert.deepEqual(track?.findings, []);
});

test("with no destination configured, the scan reports not_configured rather than an error", async () => {
  const result = await scanDestinationHealth({ settings: settingsFor(null) });

  assert.equal(result.status, "not_configured");
  assert.equal(result.root, null);
  assert.deepEqual(result.tracks, []);
  assert.equal(result.counts.totalFindings, 0);
});

test("named track inputs are validated even without a configured destination", async () => {
  await assert.rejects(
    scanDestinationHealth({ slugs: ["../outside"], settings: settingsFor(null) }),
    { code: "INVALID_SLUG" },
  );
});

/* ------------------------------------------------------------------ *
 * 3-4: root health
 * ------------------------------------------------------------------ */

test("a destination root that no longer exists is unavailable, not drifted", async (t) => {
  const root = await destination(t);
  await rm(root, { recursive: true, force: true });

  const result = await scanDestinationHealth({ settings: settingsFor(root) });

  assert.equal(result.status, "unavailable");
  assert.equal(result.root, null);
  assert.match(result.rootProblem ?? "", /not available/);
});

test("a root that exists but cannot be listed is a finding, not an unavailable status", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);

  chmodSync(root, 0o000);
  // destination(t) above already restores permissions before removing the
  // directory in its own cleanup; registering a second one here would run
  // after that cleanup, chmod-ing a path already gone.

  const result = await scanDestinationHealth({ settings: settingsFor(root) });

  // The root itself resolves fine — it exists and is a directory — so this is
  // drift the scan found, not the destination being unreachable outright.
  assert.equal(result.status, "drift");
  assert.equal(result.root, root);
  assert.ok(
    result.rootFindings.some((finding) => finding.code === "destination_folder_unreadable"),
  );

  // Every per-track check downstream of the same permission problem reports
  // itself as unreadable, never as a false "it's gone" — never
  // delivered_file_missing or track_folder_missing, which would send someone
  // to re-deliver a file that was never actually lost. The one exception is
  // the release bundle read, which treats "could not be opened" the same
  // whether the cause is ENOENT or EACCES — reasonable, since either way
  // nothing readable was found there.
  const track = result.tracks.find((entry) => entry.slug === f.slug);
  assert.ok(track);
  assert.ok(
    track!.findings.every((finding) =>
      [
        "destination_file_unreadable",
        "destination_folder_unreadable",
        "release_bundle_missing",
      ].includes(finding.code),
    ),
    JSON.stringify(track!.findings),
  );
  assert.equal(
    track!.findings.some((finding) => finding.code === "delivered_file_missing"),
    false,
  );
  assert.equal(
    track!.findings.some((finding) => finding.code === "track_folder_missing"),
    false,
  );
});

test("a destination root replaced by a symlink is detected", async (t) => {
  const real = await destination(t);
  const elsewhere = await destination(t);

  // The path *stored in settings* now resolves somewhere else than what was
  // configured — a remount, or a hand-swap at the same path.
  await rm(real, { recursive: true, force: true });
  await symlink(elsewhere, real);
  t.after(() => rm(real, { force: true }));

  const result = await scanDestinationHealth({ settings: settingsFor(real) });

  assert.ok(
    result.rootFindings.some(
      (finding) => finding.code === "destination_root_identity_changed",
    ),
    JSON.stringify(result.rootFindings),
  );
  assert.equal(result.status, "error");
  assert.deepEqual(result.tracks, []);
});

test("a root directory replaced during the scan stops before track reads", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  const moved = `${root}-moved`;
  const originalReaddirSync = fs.readdirSync;
  let swapped = false;
  t.mock.method(fs, "readdirSync", (...args: Parameters<typeof fs.readdirSync>) => {
    const entries = originalReaddirSync(...args);
    if (args[0] === root && !swapped) {
      swapped = true;
      fs.renameSync(root, moved);
      fs.mkdirSync(root);
    }
    return entries;
  });
  syncBuiltinESMExports();
  let result: Awaited<ReturnType<typeof scanDestinationHealth>>;
  try {
    result = await scanDestinationHealth({ settings: settingsFor(root) });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(moved, { recursive: true, force: true });
  }
  assert.equal(swapped, true);
  assert.equal(result.status, "error");
  assert.ok(findingCodes(result).includes("destination_root_identity_changed"));
  assert.deepEqual(result.tracks, []);
});

/* ------------------------------------------------------------------ *
 * 5-9: delivered-file checks
 * ------------------------------------------------------------------ */

test("a delivered file that matches its receipt is never flagged", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  assert.deepEqual(findingCodes(result, f.slug), []);
});

test("a delivered file that has been deleted is reported missing, with its path and delivered time", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  const track = result.tracks.find((entry) => entry.slug === f.slug)!;
  const finding = track.findings.find((entry) => entry.code === "delivered_file_missing")!;

  assert.ok(finding);
  assert.equal(finding.severity, "error");
  assert.equal(finding.relativePath, `Probe Beat/${f.slug}-youtube-16x9.mp4`);
  assert.match(finding.message, /no longer there/);
});

test("a delivered file whose size no longer matches is reported changed", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await writeFile(
    path.join(root, outcome.destinationRelativePath!),
    "a completely different, longer replacement file",
  );

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  const [finding] = result.tracks.find((entry) => entry.slug === f.slug)!.findings;

  assert.equal(finding.code, "delivered_file_changed");
  assert.equal(finding.severity, "warning");
});

test("a delivered file replaced by different content of the same size is still caught, via mtime", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });
  const target = path.join(root, outcome.destinationRelativePath!);

  // The exact same byte length as "a finished video", different content and a
  // deliberately different modification time — proving size alone is not what
  // this relies on.
  const same = "a finished video".replace("finished", "replaced");
  assert.equal(same.length, "a finished video".length);
  await writeFile(target, same);
  assert.equal((await stat(target)).size, "a finished video".length);
  const future = new Date(Date.now() + 60_000);
  utimesSync(target, future, future);

  // Once the delivered file itself changes, the release bundle's own state
  // (which asserted this exact file was delivered) is no longer accurate
  // either — a real, correct cascade, not a duplicate report of one fact.
  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  assert.deepEqual(
    [...findingCodes(result, f.slug)].sort(),
    ["delivered_file_changed", "release_bundle_outdated"].sort(),
  );
});

test("a delivered file replaced by a symlink is reported changed, and named as a link", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  const target = path.join(root, outcome.destinationRelativePath!);
  await rm(target);
  await symlink("/etc/hosts", target);

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  const [finding] = result.tracks.find((entry) => entry.slug === f.slug)!.findings;

  assert.equal(finding.code, "delivered_file_changed");
  assert.match(finding.message, /link/);
});

test("a delivered symlink is rejected even when its target copies size and mtime", async (t) => {
  const root = await destination(t);
  const outside = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  const target = path.join(root, outcome.destinationRelativePath!);
  const original = await stat(target);
  const outsideFile = path.join(outside, "same.mp4");
  await writeFile(outsideFile, await readFile(target));
  const fixed = new Date(1_700_000_000_000);
  utimesSync(target, fixed, fixed);
  utimesSync(outsideFile, fixed, fixed);
  const receiptPath = deliveryReceiptPath(f.slug, "youtube-16x9");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  receipt.mtimeMs = (await stat(target)).mtimeMs;
  await writeFile(receiptPath, JSON.stringify(receipt));
  assert.equal((await stat(outsideFile)).size, original.size);
  assert.equal((await stat(outsideFile)).mtimeMs, receipt.mtimeMs);
  await rm(target);
  await symlink(outsideFile, target);

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  const changed = result.tracks.find((entry) => entry.slug === f.slug)!.findings
    .find((entry) => entry.code === "delivered_file_changed");
  assert.match(changed?.message ?? "", /link/);
});

test("a regular replacement with copied size and mtime shows the stat-only detection limit", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  const target = path.join(root, outcome.destinationRelativePath!);
  const previous = await stat(target);
  const receiptPath = deliveryReceiptPath(f.slug, "youtube-16x9");
  const receipt = JSON.parse(await readFile(receiptPath, "utf8")) as Record<string, unknown>;
  const replacement = `${target}.replacement`;
  await writeFile(replacement, Buffer.alloc(previous.size, 65));
  utimesSync(replacement, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
  receipt.mtimeMs = (await stat(replacement)).mtimeMs;
  await writeFile(receiptPath, JSON.stringify(receipt));
  await rm(target);
  fs.renameSync(replacement, target);
  assert.notEqual((await stat(target)).ino, previous.ino);

  const result = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.equal(findingCodes(result, f.slug).includes("delivered_file_changed"), false);
});

test("unexpected export links are named without statting their targets", async (t) => {
  const root = await destination(t);
  const outside = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  const outsideFile = path.join(outside, "private.mp4");
  await writeFile(outsideFile, "outside contents");
  await symlink(outsideFile, path.join(root, f.slug, `${f.slug}-retired.mp4`));
  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  const finding = result.tracks.find((entry) => entry.slug === f.slug)!.findings
    .find((entry) => entry.code === "unexpected_export_file");
  assert.ok(finding);
  assert.doesNotMatch(finding.message, /bytes|MB|KB/);
});

test("a receipt for an old delivery folder cannot hide an export in the new folder", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Old Folder" });
  await f.publish();
  const delivered = await f.deliver(root);
  const metadata = JSON.parse(await readFile(f.metadataPath, "utf8")) as Record<string, unknown>;
  metadata.deliveryFolder = "New Folder";
  await writeFile(f.metadataPath, JSON.stringify(metadata));
  await mkdir(path.join(root, "New Folder"));
  await writeFile(
    path.join(root, "New Folder", `${f.slug}-youtube-16x9.mp4`),
    await readFile(path.join(root, delivered.destinationRelativePath!)),
  );

  const result = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.ok(findingCodes(result, f.slug).includes("unexpected_export_file"));
});

test("a bundle file replaced by a link is reported without reading its target", async (t) => {
  const root = await destination(t);
  const outside = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });
  const bundle = path.join(root, f.slug, "release.json");
  const outsideFile = path.join(outside, "release.json");
  await writeFile(outsideFile, await readFile(bundle));
  await rm(bundle);
  await symlink(outsideFile, bundle);

  const result = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.ok(findingCodes(result, f.slug).includes("destination_file_unreadable"));
  assert.equal(result.tracks[0].findings.some((entry) => entry.message.includes(outside)), false);
});

/* ------------------------------------------------------------------ *
 * 10-12: unexpected files and folders
 * ------------------------------------------------------------------ */

test("a file matching this app's naming convention with no receipt is unexpected", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await f.deliver(root);

  // Shaped exactly like a delivery, from a preset that is not even a real one
  // any more — the "export from a retired preset" case.
  const stray = path.join(root, "Probe Beat", managedExportFilename(f.slug, "imax-70mm"));
  await writeFile(stray, "an old leftover export");

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  const findings = result.tracks.find((entry) => entry.slug === f.slug)!.findings;

  assert.equal(
    findings.filter((finding) => finding.code === "unexpected_export_file").length,
    1,
  );
  assert.equal(
    findings.find((finding) => finding.code === "unexpected_export_file")!.relativePath,
    `Probe Beat/${f.slug}-imax-70mm.mp4`,
  );
});

test("a malformed receipt cannot claim the file it once described", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  await writeFile(deliveryReceiptPath(f.slug, "youtube-16x9"), "{broken");
  const result = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.ok(findingCodes(result, f.slug).includes("unexpected_export_file"));
});

test("corrupt delivery history does not affect current destination health", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });
  await writeFile(path.join(root, "delivery-log.jsonl"), "{broken\n");
  const result = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.deepEqual(findingCodes(result, f.slug), []);
});

test("a file outside this app's naming convention is never treated as drift", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });

  for (const name of ["notes.txt", "trailer.mp4", "cover-backup.png", `${f.slug}`, ".DS_Store"]) {
    await writeFile(path.join(root, "Probe Beat", name), "whatever a person put here");
  }

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  assert.deepEqual(findingCodes(result, f.slug), []);

  // The pure predicate agrees, independent of any scan.
  assert.equal(looksLikeManagedExportFile("trailer.mp4", f.slug), false);
  assert.equal(looksLikeManagedExportFile(".DS_Store", f.slug), false);
});

test("an orphaned folder that looks app-managed is mentioned, but only for a catalogue scan", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);

  // What a renamed or removed track leaves behind: bookkeeping files, no
  // active track resolving to this folder name.
  await mkdir(path.join(root, "Old Track"));
  await writeFile(path.join(root, "Old Track", "release.json"), "{}");
  // An entirely unrelated folder, which must never be flagged.
  await mkdir(path.join(root, "Photos"));
  await writeFile(path.join(root, "Photos", "vacation.jpg"), "not ours");

  const catalogue = await scanDestinationHealth({ settings: settingsFor(root) });
  const orphan = catalogue.rootFindings.filter((finding) => finding.code === "unexpected_track_folder");
  assert.equal(orphan.length, 1);
  assert.equal(orphan[0].relativePath, "Old Track");

  // A narrowed, single-track request never runs the root-wide sweep: judging
  // "orphaned" needs every active track's folder loaded, which it does not
  // have.
  const single = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.deepEqual(single.rootFindings, []);
});

/* ------------------------------------------------------------------ *
 * 13-16: release bundle health
 * ------------------------------------------------------------------ */

test("something delivered with no release bundle yet is reported, once, as missing", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  // No generateReleaseBundle() call.

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  assert.deepEqual(findingCodes(result, f.slug), ["release_bundle_missing"]);
  assert.equal(
    result.tracks.find((entry) => entry.slug === f.slug)!.findings[0].severity,
    "info",
  );
});

test("nothing delivered and no bundle is healthy, not a missing-bundle finding", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  // Never published, never delivered.

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  assert.deepEqual(findingCodes(result, f.slug), []);
});

test("release.md missing reads as the bundle being outdated", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });
  await rm(path.join(root, "Probe Beat", "release.md"));

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  assert.deepEqual(findingCodes(result, f.slug), ["release_bundle_outdated"]);
});

test("release.json and release.md disagreeing with each other is its own, more specific finding", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });

  // Both files still present and individually parseable, but no longer
  // naming the same bundle — the one thing that cannot be a coincidence of
  // ordinary staleness.
  const jsonPath = path.join(root, "Probe Beat", "release.json");
  const bundle = JSON.parse(await readFile(jsonPath, "utf8")) as { bundleId: string };
  await writeFile(
    jsonPath,
    JSON.stringify({ ...bundle, bundleId: "f".repeat(64) }, null, 2),
  );

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  assert.deepEqual(findingCodes(result, f.slug), ["release_bundle_pair_mismatch"]);
});

test("a bundle merely behind current state is outdated, not a pair mismatch", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });

  // The two files still agree with each other; only current state has moved
  // on — a second format becoming intended, say.
  await writeFile(
    f.metadataPath,
    JSON.stringify({
      title: "Fixture",
      artist: "Toshi",
      key: "F Minor",
      bpm: 100,
      deliveryFolder: "Probe Beat",
      exportPresets: ["youtube-16x9", "square-1x1"],
    }),
  );

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  assert.deepEqual(findingCodes(result, f.slug), ["release_bundle_outdated"]);
});

/* ------------------------------------------------------------------ *
 * 17-18: partial and empty delivery are valid
 * ------------------------------------------------------------------ */

test("delivering only one of two intended formats is a valid, healthy state", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { exportPresets: ["youtube-16x9", "square-1x1"] });
  await f.publish("youtube-16x9");
  await f.deliver(root, "youtube-16x9");
  // square-1x1 is intended but was never rendered or delivered.

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  // A release-bundle-missing finding is expected (something was delivered),
  // but nothing about the undelivered second format.
  const codes = findingCodes(result, f.slug);
  assert.deepEqual(codes, ["release_bundle_missing"]);
});

test("a track with no deliveries at all is healthy", async (t) => {
  const root = await destination(t);
  const f = await setup(t);

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  assert.deepEqual(findingCodes(result, f.slug), []);
});

/* ------------------------------------------------------------------ *
 * 19-20: receipts and files, both directions, together
 * ------------------------------------------------------------------ */

test("a missing delivered file and an unaccounted-for file are reported separately in one scan", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat", exportPresets: ["youtube-16x9", "square-1x1"] });
  await f.publish("youtube-16x9");
  await f.publish("square-1x1", "a square video");
  const first = await f.deliver(root, "youtube-16x9");
  await f.deliver(root, "square-1x1");

  // The receipt for 16:9 now names a file that is gone...
  await rm(path.join(root, first.destinationRelativePath!));
  // ...and a stray file with no receipt behind it sits alongside the real one.
  await writeFile(
    path.join(root, "Probe Beat", managedExportFilename(f.slug, "vertical-9x16")),
    "leftover",
  );

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  const findings = result.tracks.find((entry) => entry.slug === f.slug)!.findings;

  const missing = findings.filter((finding) => finding.code === "delivered_file_missing");
  const unexpected = findings.filter((finding) => finding.code === "unexpected_export_file");
  assert.equal(missing.length, 1);
  assert.equal(missing[0].presetId, "youtube-16x9");
  assert.equal(unexpected.length, 1);
  assert.match(unexpected[0].relativePath!, /vertical-9x16/);
});

/* ------------------------------------------------------------------ *
 * 21-22: point-in-time semantics
 * ------------------------------------------------------------------ */

test("a file removed between listing and inspection produces a coherent finding, not a crash", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await f.deliver(root);

  const strayPath = path.join(root, "Probe Beat", managedExportFilename(f.slug, "vertical-9x16"));
  await writeFile(strayPath, "about to vanish");

  const originalLstatSync = fs.lstatSync;
  t.mock.method(fs, "lstatSync", (...args: Parameters<typeof fs.lstatSync>) => {
    if (typeof args[0] === "string" && args[0] === strayPath) {
      const error = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      error.code = "ENOENT";
      throw error;
    }
    return originalLstatSync(...args);
  });
  syncBuiltinESMExports();

  let result: Awaited<ReturnType<typeof scanDestinationHealth>>;
  try {
    result = await scanDestinationHealth({ settings: settingsFor(root) });
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }

  const finding = result.tracks
    .find((entry) => entry.slug === f.slug)!
    .findings.find((entry) => entry.code === "unexpected_export_file");

  // Still reported — the readdir listing already knew the name — but with no
  // size, rather than the scan throwing over a file that vanished underneath
  // it. A snapshot, not a transaction.
  assert.ok(finding);
  assert.equal(finding!.message.includes("MB"), false);
});

test("a track's folder changing between deliveries is reflected in the very next scan", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "First Name" });
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });

  const before = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.equal(before.tracks[0].folder, "First Name");
  assert.deepEqual(before.tracks[0].findings, []);

  // The folder is renamed in metadata, without touching the destination.
  await writeFile(
    f.metadataPath,
    JSON.stringify({
      title: "Fixture",
      artist: "Toshi",
      key: "F Minor",
      bpm: 100,
      deliveryFolder: "Second Name",
    }),
  );

  const after = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  // A snapshot of *now*: the scan looks under the currently effective folder,
  // finds nothing delivered there yet (the receipt still names the old
  // folder, so it is not "at this destination" any more — the delivery
  // planner's own rule, reused here) rather than anything stale.
  assert.equal(after.tracks[0].folder, "Second Name");
});

/* ------------------------------------------------------------------ *
 * 23-24: symlink and path safety
 * ------------------------------------------------------------------ */

test("a track folder replaced by a symlink is never followed", async (t) => {
  const root = await destination(t);
  const outside = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await f.deliver(root);

  const folderPath = path.join(root, "Probe Beat");
  await rm(folderPath, { recursive: true });
  // Points outside the configured root entirely.
  await mkdir(path.join(outside, "shadow"));
  await writeFile(path.join(outside, "shadow", "secret.txt"), "should never be read");
  await symlink(path.join(outside, "shadow"), folderPath);

  const result = await scanDestinationHealth({ settings: settingsFor(root) });
  const findings = result.tracks.find((entry) => entry.slug === f.slug)!.findings;

  // Treated as an unreadable entry — never as a directory to list through. Nothing about
  // "secret.txt" appears anywhere in the result.
  assert.ok(findings.some((finding) => finding.code === "destination_folder_unreadable"));
  assert.equal(JSON.stringify(result).includes("secret"), false);
});

test("a delivery folder cannot be steered outside the destination root", async (t) => {
  const root = await destination(t);
  const f = await fixture(t);
  // Written directly, bypassing the normal validated write path — the one way
  // an invalid value could end up on disk. Strict metadata parsing already
  // rejects the whole document over it (one invalid field nulls all of it),
  // so this exercises the *fallback* path: deliveryFolderFor(slug, undefined)
  // — and separately proves the scanner's own try/catch around it, which the
  // brief specifically asks for, never lets a bad value further than that.
  await writeFile(
    f.metadata,
    JSON.stringify({
      title: "Fixture",
      artist: "Toshi",
      key: "F Minor",
      bpm: 100,
      deliveryFolder: "../../etc",
    }),
  );

  const result = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });

  // Never escapes to the real folder it names, and never appears anywhere in
  // the result — the value was neutralised, not merely refused.
  assert.equal(JSON.stringify(result).includes("etc"), false);
  assert.equal(JSON.stringify(result).includes(".."), false);
  // Falls back to the slug, exactly as an undeclared folder does.
  assert.equal(result.tracks[0]?.folder, f.slug);

  // The scanner's own defence is real, not merely unreachable: a folder value
  // that skips metadata's validation cannot skip this one too.
  const { deliveryFolderFor } = await import("../core/domain/delivery/deliveryPaths.ts");
  assert.throws(() => deliveryFolderFor(f.slug, "../../etc"), { code: "METADATA_INVALID" });
});

test("looksLikeManagedTrackFolder only recognises this app's own bookkeeping or current-preset naming", () => {
  assert.equal(looksLikeManagedTrackFolder(["release.json"], []), true);
  assert.equal(looksLikeManagedTrackFolder(["release.md"], []), true);
  assert.equal(looksLikeManagedTrackFolder(["ghetto-geek-youtube-16x9.mp4"], ["youtube-16x9"]), true);
  assert.equal(looksLikeManagedTrackFolder(["vacation.jpg", "notes.txt"], ["youtube-16x9"]), false);
  assert.equal(looksLikeManagedTrackFolder([], ["youtube-16x9"]), false);
});

/* ------------------------------------------------------------------ *
 * 25-26: scope
 * ------------------------------------------------------------------ */

test("scanning one track never touches or reports on any other track", async (t) => {
  const root = await destination(t);
  const a = await setup(t, { deliveryFolder: "Track A" });
  const b = await setup(t, { deliveryFolder: "Track B" });
  await a.publish();
  await a.deliver(root);
  await rm(path.join(root, "Track A", `${a.slug}-youtube-16x9.mp4`));
  // b is never touched — its absence must never leak into a's result.

  const result = await scanDestinationHealth({ slugs: [a.slug], settings: settingsFor(root) });

  assert.equal(result.catalogue, false);
  assert.equal(result.tracks.length, 1);
  assert.equal(result.tracks[0].slug, a.slug);
  assert.equal(result.tracks.some((entry) => entry.slug === b.slug), false);
});

test("a catalogue scan covers every track and reports what cannot be scanned", async (t) => {
  const root = await destination(t);
  const a = await setup(t);
  const b = await setup(t);
  await a.publish();
  await a.deliver(root);

  const result = await scanDestinationHealth({ settings: settingsFor(root) });

  // A superset check: the catalogue also includes this repository's own real
  // tracks (ghetto-geek), which a catalogue-wide scan correctly covers too.
  assert.equal(result.catalogue, true);
  const slugs = result.tracks.map((entry) => entry.slug);
  assert.ok(slugs.includes(a.slug));
  assert.ok(slugs.includes(b.slug));

  const named = await scanDestinationHealth({
    slugs: ["not-a-real-track"],
    settings: settingsFor(root),
  });
  assert.equal(named.tracks.length, 0);
  assert.equal(named.invalid.length, 1);
  assert.equal(named.status, "error");
  assert.match(named.invalid[0].reason, /not found/);
});

/* ------------------------------------------------------------------ *
 * 30: never mutates anything
 * ------------------------------------------------------------------ */

test("a scan over every kind of drift changes not one byte at the destination", async (t) => {
  const root = await destination(t);
  const f = await setup(t, { deliveryFolder: "Probe Beat" });
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });
  await rm(path.join(root, "Probe Beat", `${f.slug}-youtube-16x9.mp4`));
  await writeFile(
    path.join(root, "Probe Beat", managedExportFilename(f.slug, "vertical-9x16")),
    "unexpected",
  );
  await mkdir(path.join(root, "Old Track"));
  await writeFile(path.join(root, "Old Track", "release.json"), "{}");

  const before = await snapshot(root);
  // Scoped to this fixture's own slug, like every other test in this file --
  // omitting `slugs` here (as this test used to) makes the scan catalogue-
  // wide, which lists the real shared public/tracks/ directory via
  // listTracks(). Under the test runner's cross-file concurrency, another
  // file's own regression-<uuid> fixture can be torn down by its own test's
  // t.after() between that listing and this scan's per-track inspection,
  // producing an intermittent ENOENT that has nothing to do with what this
  // test actually verifies (that a scan never mutates the destination).
  // Orphan-folder detection itself (which needs catalogue mode) already has
  // its own dedicated coverage below ("an orphaned folder that looks
  // app-managed is mentioned, but only for a catalogue scan"); this test
  // still keeps the "Old Track" folder on disk to prove a scoped scan never
  // touches unrelated destination content either.
  await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  const after = await snapshot(root);

  assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort());
});

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

const run = promisify(execFile);

test("the CLI documents itself and never writes without a destination", async () => {
  const help = await run(process.execPath, ["scripts/destination-health.mts", "--help"]);
  assert.match(help.stderr, /--track <slug>/);
  assert.match(help.stderr, /--json/);
  assert.match(help.stderr, /Nothing here writes or deletes/);

  const noDestination = await run(process.execPath, [
    "scripts/destination-health.mts",
  ]).catch((error: { stdout: string }) => error);
  // Whatever this machine's own delivery.local.json says, the command must
  // never throw an unhandled exception — only ever a clean, reported result.
  assert.equal(typeof (noDestination as { stdout?: string }).stdout, "string");
});

test("the CLI refuses unknown options and invalid track slugs", async () => {
  for (const args of [["--unexpected"], ["--track", "../outside"], ["--track"]]) {
    await assert.rejects(
      run(process.execPath, ["scripts/destination-health.mts", ...args]),
      (error: { code?: number; stderr?: string }) =>
        error.code !== 0 && /unknown|not a valid|needs a value/i.test(error.stderr ?? ""),
    );
  }
});
