import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import {
  applyDestinationFixPlan,
  planDestinationFix,
} from "../services/workflows/destinationFixPlan.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import type { DeliverySettings } from "../services/delivery/deliverySettings.ts";
import { generateReleaseBundle, releaseBundlePaths } from "../services/delivery/releaseBundle.ts";
import { scanDestinationHealth } from "../services/workflows/destinationHealth.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import type { RenderPresetId } from "../core/domain/video/renderPresets.ts";
import { fixture } from "./fixtures.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

await isolateRenderJournalForThisFile();

const execFileAsync = promisify(execFile);

/**
 * Destination fix planning: turning destination health findings into a
 * reviewed, typed plan, and — only when told to — running the safe actions.
 *
 * Same conventions as destination-health.test.mts: real temp directories,
 * delivery always performed through the real pipeline, drift created by
 * mutating only the destination. `settings` is always explicit so no test
 * touches the project's own delivery.local.json.
 */

const destination = async (t: TestContext) => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "toshi-fixplan-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
};

const settingsFor = (root: string | null): DeliverySettings => ({
  schemaVersion: 1,
  root,
  autoDeliver: false,
  autoUpdateReleaseBundle: false,
});

const setup = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const f = await fixture(t, extra);
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));

  const metadata = parseTrackMetadata(JSON.parse(await readFile(f.metadata, "utf8")), "fixture");
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

  return { ...f, metadata, props, publish, deliver, coverage };
};

const action = (
  plan: Awaited<ReturnType<typeof planDestinationFix>>,
  kind: string,
  slug?: string | null,
) => plan.actions.find((a) => a.kind === kind && (slug === undefined || a.slug === slug));

/* ------------------------------------------------------------------ *
 * 1: healthy -> empty plan
 * ------------------------------------------------------------------ */

test("a healthy destination produces an empty plan", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });

  assert.equal(plan.status, "healthy");
  assert.deepEqual(plan.actions, []);
  assert.equal(plan.summary.safeActions, 0);
  assert.equal(plan.summary.manualActions, 0);
  assert.equal(plan.summary.blocked, false);
});

/* ------------------------------------------------------------------ *
 * 2-5: delivered-file drift, redeliver vs rerender
 * ------------------------------------------------------------------ */

test("a missing delivered file with a current canonical export proposes a redeliver", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });

  const redeliver = action(plan, "redeliver", f.slug);
  assert.ok(redeliver, JSON.stringify(plan.actions));
  assert.equal(redeliver!.presetId, "youtube-16x9");
  assert.equal(redeliver!.safety, "safe");
  assert.equal(redeliver!.executable, true);
  assert.deepEqual([...redeliver!.findingCodes], ["delivered_file_missing"]);
  assert.equal(action(plan, "rerender_and_deliver", f.slug), undefined);
});

test("a missing delivered file with a stale canonical export proposes a rerender", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);
  await rm(trackOutputLocation(f.slug, "youtube-16x9").path);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });

  const rerender = action(plan, "rerender_and_deliver", f.slug);
  assert.ok(rerender, JSON.stringify(plan.actions));
  assert.equal(action(plan, "redeliver", f.slug), undefined);
});

test("a changed delivered file with a current canonical export proposes a redeliver", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await writeFile(outcome.destinationPath!, "not the same file at all, different length");

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });

  const redeliver = action(plan, "redeliver", f.slug);
  assert.ok(redeliver, JSON.stringify(plan.actions));
  assert.deepEqual([...redeliver!.findingCodes], ["delivered_file_changed"]);
});

test("a changed delivered file with a stale canonical export proposes a rerender", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await writeFile(outcome.destinationPath!, "not the same file at all, different length");
  await rm(trackOutputLocation(f.slug, "youtube-16x9").path);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });

  assert.ok(action(plan, "rerender_and_deliver", f.slug));
});

/* ------------------------------------------------------------------ *
 * 6-8: release bundle drift
 * ------------------------------------------------------------------ */

test("a missing release bundle proposes regenerating it", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });

  const bundle = action(plan, "regenerate_release_bundle", f.slug);
  assert.ok(bundle);
  assert.deepEqual([...bundle!.findingCodes], ["release_bundle_missing"]);
});

test("an outdated release bundle proposes regenerating it", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });
  // Deliver again with different content, so the bundle now describes stale state.
  await f.publish("youtube-16x9", "a longer finished video than before");
  await f.deliver(root);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });

  const bundle = action(plan, "regenerate_release_bundle", f.slug);
  assert.ok(bundle, JSON.stringify(plan.actions));
});

test("a pair-mismatched release bundle proposes regenerating it", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });
  await f.publish("youtube-16x9", "a longer finished video than before");
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });
  const paths = releaseBundlePaths(root, f.slug);
  const json = JSON.parse(await readFile(paths.json, "utf8")) as { bundleId: string };
  await writeFile(paths.markdown, (await readFile(paths.markdown, "utf8")).replace(json.bundleId.slice(0, 8), "aaaaaaaa"));

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });

  const bundle = action(plan, "regenerate_release_bundle", f.slug);
  assert.ok(bundle, JSON.stringify(plan.actions));
});

/* ------------------------------------------------------------------ *
 * 9-10: manual-only findings
 * ------------------------------------------------------------------ */

test("an unexpected export file is manual review only, never a safe action", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  await writeFile(path.join(root, f.slug, `${f.slug}-vertical-9x16.mp4`), "a stray file");

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });

  const manual = action(plan, "manual_review", f.slug);
  assert.ok(manual);
  assert.equal(manual!.safety, "manual");
  assert.equal(manual!.executable, false);
  assert.deepEqual([...manual!.findingCodes], ["unexpected_export_file"]);
});

test("an unexpected top-level folder is manual review only, and only for a catalogue scan", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  await mkdir(path.join(root, "leftover-track"));
  await writeFile(path.join(root, "leftover-track", "leftover-track-youtube-16x9.mp4"), "x");

  const catalogue = await planDestinationFix({ settings: settingsFor(root) });
  assert.ok(action(catalogue, "manual_review", null));
  assert.ok(catalogue.actions.some((a) => a.relativePath === "leftover-track"));

  const single = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  assert.equal(single.actions.some((a) => a.relativePath === "leftover-track"), false);
});

/* ------------------------------------------------------------------ *
 * 11: destination unavailable -> blocked
 * ------------------------------------------------------------------ */

test("a root that no longer exists blocks planning entirely", async (t) => {
  const root = await destination(t);
  await rm(root, { recursive: true, force: true });

  const plan = await planDestinationFix({ settings: settingsFor(root) });

  assert.equal(plan.status, "unavailable");
  assert.equal(plan.summary.blocked, true);
  assert.equal(plan.summary.safeActions, 0);
  assert.ok(plan.actions.every((a) => a.kind === "manual_review"));
});

/* ------------------------------------------------------------------ *
 * 12: deduplication
 * ------------------------------------------------------------------ */

test("a missing delivery and a missing bundle for the same track produce two actions, one of each, the bundle depending on the delivery", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });

  const trackActions = plan.actions.filter((a) => a.slug === f.slug);
  assert.equal(trackActions.length, 2, JSON.stringify(trackActions));
  const redeliver = action(plan, "redeliver", f.slug)!;
  const bundle = action(plan, "regenerate_release_bundle", f.slug)!;
  assert.ok(bundle.dependsOn.includes(redeliver.id));
});

/* ------------------------------------------------------------------ *
 * 13: dependency ordering
 * ------------------------------------------------------------------ */

test("applying a bundle action without its prerequisite is blocked, not silently run", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const bundle = action(plan, "regenerate_release_bundle", f.slug)!;

  const { results } = await applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [bundle.id],
  });

  assert.equal(results[0]!.status, "blocked");
  assert.match(results[0]!.reason ?? "", /not included in this apply/);
});

/* ------------------------------------------------------------------ *
 * 14-15: scope
 * ------------------------------------------------------------------ */

test("a single-track plan never reports another track's drift", async (t) => {
  const root = await destination(t);
  const a = await setup(t);
  const b = await setup(t);
  await a.publish();
  const outcomeA = await a.deliver(root);
  await rm(outcomeA.destinationPath!);
  await b.publish();
  const outcomeB = await b.deliver(root);
  await rm(outcomeB.destinationPath!);

  const plan = await planDestinationFix({ slugs: [a.slug], settings: settingsFor(root) });

  assert.ok(plan.actions.some((act) => act.slug === a.slug));
  assert.equal(plan.actions.some((act) => act.slug === b.slug), false);
});

/* ------------------------------------------------------------------ *
 * 16: dry-run performs zero writes
 * ------------------------------------------------------------------ */

test("planning never writes anything at the destination", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);
  await writeFile(path.join(root, f.slug, `${f.slug}-vertical-9x16.mp4`), "stray");

  const before = await stat(path.join(root, f.slug));
  await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const after = await stat(path.join(root, f.slug));

  assert.equal(before.mtimeMs, after.mtimeMs);
});

/* ------------------------------------------------------------------ *
 * 17: apply cannot act on an unknown id
 * ------------------------------------------------------------------ */

test("apply-plan cannot be made to run an action that does not exist in a fresh plan", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  await f.deliver(root);
  await generateReleaseBundle({ slug: f.slug, settings: settingsFor(root) });

  const { results } = await applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: ["not-a-real-action-id"],
  });

  assert.equal(results[0]!.status, "skipped_already_fixed");
  const health = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.equal(health.status, "healthy");
});

/* ------------------------------------------------------------------ *
 * 20-21: stale-plan revalidation / already-fixed
 * ------------------------------------------------------------------ */

test("an action revalidated at apply time and found already fixed is skipped, not repeated", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const redeliver = action(plan, "redeliver", f.slug)!;

  // Someone else fixes it by hand before apply runs.
  await f.deliver(root);

  const { results } = await applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [redeliver.id],
  });

  assert.equal(results[0]!.status, "skipped_already_fixed");
});

test("applying the same plan twice is safe: the second run does nothing further", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const ids = plan.actions.filter((a) => a.executable).map((a) => a.id);

  const first = await applyDestinationFixPlan({ slugs: [f.slug], settings: settingsFor(root), actionIds: ids });
  assert.ok(first.results.some((r) => r.status === "completed"));

  const second = await applyDestinationFixPlan({ slugs: [f.slug], settings: settingsFor(root), actionIds: ids });
  assert.ok(second.results.every((r) => r.status === "skipped_already_fixed"), JSON.stringify(second.results));

  const health = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.equal(health.status, "healthy");
});

/* ------------------------------------------------------------------ *
 * 23: a failed delivery blocks its dependent bundle action
 * ------------------------------------------------------------------ */

test("a redeliver whose canonical export goes stale between plan and apply is queued as a rerender instead, and its dependent bundle update is blocked", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const redeliver = action(plan, "redeliver", f.slug)!;
  const bundle = action(plan, "regenerate_release_bundle", f.slug)!;

  // The canonical export itself vanishes between plan and apply. apply-plan
  // re-derives its own plan fresh, so this is not a stale-id lookup miss —
  // it finds the very same id (redeliver and rerender share one identity),
  // now correctly needing a render instead of a copy.
  await rm(trackOutputLocation(f.slug, "youtube-16x9").path);

  const { results } = await applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [redeliver.id, bundle.id],
  });

  const redeliverResult = results.find((r) => r.actionId === redeliver.id)!;
  const bundleResult = results.find((r) => r.actionId === bundle.id)!;
  assert.equal(redeliverResult.status, "queued");
  assert.equal(redeliverResult.kind, "rerender_and_deliver");
  // A queued render is not a settled success: the bundle must not run yet.
  assert.equal(bundleResult.status, "blocked");
});

test("a delivery that fails outright at apply time blocks its dependent bundle update", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const redeliver = action(plan, "redeliver", f.slug)!;
  const bundle = action(plan, "regenerate_release_bundle", f.slug)!;

  // Leave the canonical export current, but make the track's own destination
  // folder unwritable, so the copy itself fails rather than being reclassified.
  // Restored inline (not via t.after) before this test returns: destination(t)
  // registered its own recursive-delete cleanup first, and t.after hooks run
  // in registration order, so a cleanup hook added here would fire only after
  // that delete already ran, chmod-ing a path that no longer exists.
  const trackFolder = path.join(root, f.slug);
  chmodSync(trackFolder, 0o500);

  const { results } = await applyDestinationFixPlan({
    slugs: [f.slug],
    settings: settingsFor(root),
    actionIds: [redeliver.id, bundle.id],
  });

  chmodSync(trackFolder, 0o700);

  const redeliverResult = results.find((r) => r.actionId === redeliver.id)!;
  const bundleResult = results.find((r) => r.actionId === bundle.id)!;
  assert.equal(redeliverResult.status, "failed");
  assert.equal(bundleResult.status, "blocked");
});

/* ------------------------------------------------------------------ *
 * 24: unrelated tracks continue
 * ------------------------------------------------------------------ */

test("one track's problem never stops another track's action from completing", async (t) => {
  const root = await destination(t);
  const a = await setup(t);
  const b = await setup(t);
  await a.publish();
  const outcomeA = await a.deliver(root);
  await rm(outcomeA.destinationPath!);
  await b.publish();
  const outcomeB = await b.deliver(root);
  await rm(outcomeB.destinationPath!);

  const plan = await planDestinationFix({ slugs: [a.slug, b.slug], settings: settingsFor(root) });
  const redeliverA = action(plan, "redeliver", a.slug)!;
  const redeliverB = action(plan, "redeliver", b.slug)!;

  // Break track A's delivery folder only, so its copy fails. Restored inline,
  // not via t.after — see the note in the previous test about hook ordering.
  const folderA = path.join(root, a.slug);
  chmodSync(folderA, 0o500);

  const { results } = await applyDestinationFixPlan({
    slugs: [a.slug, b.slug],
    settings: settingsFor(root),
    actionIds: [redeliverA.id, redeliverB.id],
  });

  chmodSync(folderA, 0o700);

  assert.equal(results.find((r) => r.actionId === redeliverA.id)!.status, "failed");
  assert.equal(results.find((r) => r.actionId === redeliverB.id)!.status, "completed");
});

/* ------------------------------------------------------------------ *
 * 26: no destructive deletion
 * ------------------------------------------------------------------ */

test("applying every safe action never removes the unexpected file a manual finding named", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);
  const strayPath = path.join(root, f.slug, `${f.slug}-vertical-9x16.mp4`);
  await writeFile(strayPath, "stray content");

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const safeIds = plan.actions.filter((a) => a.executable).map((a) => a.id);
  await applyDestinationFixPlan({ slugs: [f.slug], settings: settingsFor(root), actionIds: safeIds });

  const strayContent = await readFile(strayPath, "utf8");
  assert.equal(strayContent, "stray content");
});

/* ------------------------------------------------------------------ *
 * 29-30: bundle relationship and end-to-end healthy-after-apply
 * ------------------------------------------------------------------ */

test("applying a full safe plan brings the destination back to healthy", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(outcome.destinationPath!);

  const before = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.equal(before.status, "drift");

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const ids = plan.actions.filter((a) => a.executable).map((a) => a.id);
  const { results } = await applyDestinationFixPlan({ slugs: [f.slug], settings: settingsFor(root), actionIds: ids });
  assert.ok(results.every((r) => r.status === "completed"), JSON.stringify(results));

  const after = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  assert.equal(after.status, "healthy");
});

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

test("the destination-fix-plan CLI documents that it defaults to a dry run and needs --apply to change anything", async () => {
  const { stderr } = await execFileAsync("node", ["scripts/destination-fix-plan.mts", "--help"]);
  assert.match(stderr, /--apply/);
  assert.match(stderr, /DRY RUN/);
});

test("the destination-fix-plan CLI runs without crashing when nothing is configured", async () => {
  const { stdout } = await execFileAsync("node", ["scripts/destination-fix-plan.mts"]);
  assert.match(stdout, /no destination|not.*configured/i);
});

test("the destination-fix-plan CLI refuses malformed wait timeouts", async () => {
  for (const timeout of ["0", "nope", "-2"]) {
    await assert.rejects(
      execFileAsync("node", ["scripts/destination-fix-plan.mts", "--apply", "--wait", "--timeout", timeout]),
      (error: { code?: number; stderr?: string }) =>
        error.code !== 0 && /positive number/.test(error.stderr ?? ""),
    );
  }
  const huge = await execFileAsync("node", ["scripts/destination-fix-plan.mts", "--timeout", "1000000000"]);
  assert.match(huge.stdout, /DRY RUN/);
});
