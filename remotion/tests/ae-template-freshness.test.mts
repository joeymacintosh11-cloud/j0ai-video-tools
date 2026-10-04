import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rename, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { renderEngines } from "../adapters/renderEngines.mts";
import { readAfterEffectsConfig } from "../adapters/after-effects/afterEffectsConfig.mts";
import { afterEffectsTemplateIdentity, readAfterEffectsTemplateIdentity } from "../adapters/after-effects/templateIdentity.mts";
import { PREPARATION_VERSION } from "../adapters/after-effects/afterEffectsScripting.mts";
import { registerTemplateIdentityReader } from "../services/render/templateIdentity.ts";
import { fingerprintInputs, fileContentHash, inputFingerprint, readExportManifest } from "../services/tracks/exportManifest.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { planMissingExports, toRenderTargets } from "../services/workflows/exportPlan.ts";
import { toTrackDetailView, toTrackSummaryView } from "../services/workflows/trackView.ts";
import { buildContentPackagesForSlugs, planContentPackageBatch } from "../services/workflows/contentPackagePlan.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import { fixture } from "./fixtures.mts";
import type { RendererId } from "../core/domain/video/renderers.ts";

const setup = async (t: TestContext, mode: "manual" | "auto" = "auto") => {
  const dir = await mkdtemp(path.join(tmpdir(), "ae-freshness-"));
  const project = path.join(dir, "base.aep");
  const configFile = path.join(dir, "config.json");
  await writeFile(project, "RIFX synthetic template A");
  await writeFile(configFile, JSON.stringify({ project, composition: "Synthetic comp", templatePreparation: mode }));
  const before = process.env.TOSHI_AE_CONFIG;
  process.env.TOSHI_AE_CONFIG = configFile;
  t.after(async () => {
    if (before === undefined) delete process.env.TOSHI_AE_CONFIG;
    else process.env.TOSHI_AE_CONFIG = before;
    await rm(dir, { recursive: true, force: true });
  });
  const track = async (renderer: RendererId = "after-effects") => {
    const f = await fixture(t, { renderer, exportPresets: ["youtube-16x9"] });
    await writeFile(f.cover, "cover"); await writeFile(f.beat, "audio");
    t.after(() => rm(f.outputDir, { recursive: true, force: true }));
    const inspection = await inspectTrack(f.slug);
    const props = buildTrackProps({ slug: f.slug, metadata: inspection.metadata!, analysisAvailable: true });
    const inputs = () => fingerprintInputs(props, "youtube-16x9", undefined, renderer,
      renderer === "after-effects" ? readAfterEffectsTemplateIdentity("youtube-16x9").template! : undefined);
    const publish = () => publishExport(f.slug, "youtube-16x9", inputs(), async (file) => { await writeFile(file, "synthetic video"); }, undefined, undefined, renderer);
    const state = () => trackExportCoverage(f.slug, undefined, renderer)[0];
    return { ...f, inspection, props, inputs, publish, state };
  };
  return { dir, project, configFile, track };
};

for (const mode of ["manual", "auto"] as const) {
  test(`${mode}: unchanged template stays fresh; editing the base makes the export stale without rendering`, async (t) => {
    const c = await setup(t, mode), f = await c.track();
    await f.publish();
    assert.equal(f.state().freshness, "current");
    await writeFile(c.project, "RIFX synthetic template B");
    assert.deepEqual(f.state().staleReasons, ["template_changed"]);
    assert.equal(f.state().freshness, "stale");
    await f.publish(); assert.equal(f.state().freshness, "current");
  });
}

test("preparation version, mode and selected composition participate in freshness", async (t) => {
  const c = await setup(t), f = await c.track(); await f.publish();
  const restore = registerTemplateIdentityReader("after-effects", (preset) => ({
    template: afterEffectsTemplateIdentity(readAfterEffectsConfig(c.configFile), preset, fileContentHash(c.project), "next-contract"), problem: null,
  }));
  assert.deepEqual(f.state().staleReasons, ["template_changed"]); restore();
  for (const settings of [{ templatePreparation: "manual", composition: "Synthetic comp" }, { templatePreparation: "auto", composition: "Other comp" }]) {
    await writeFile(c.configFile, JSON.stringify({ project: c.project, ...settings }));
    assert.deepEqual(f.state().staleReasons, ["template_changed"]);
  }
});

test("two tracks and different working copies share canonical identity; cache presence is irrelevant", async (t) => {
  const c = await setup(t), a = await c.track(), b = await c.track();
  assert.equal(a.inputs().template, b.inputs().template);
  const config = readAfterEffectsConfig(c.configFile);
  await fs.promises.mkdir(config.workingDirectory);
  await writeFile(path.join(config.workingDirectory, "track-a.aep"), "different working copy A");
  await writeFile(path.join(config.workingDirectory, "track-b.aep"), "different working copy B");
  await a.publish(); await b.publish();
  assert.equal(a.state().freshness, "current"); assert.equal(b.state().freshness, "current");
  await rm(config.workingDirectory, { recursive: true });
  assert.equal(a.state().freshness, "current"); assert.equal(b.state().freshness, "current");
  assert.match(readAfterEffectsTemplateIdentity("youtube-16x9").template!.version, new RegExp(PREPARATION_VERSION));
});

test("historical AE manifest without explicit identity is stale even if its other inputs match", async (t) => {
  const c = await setup(t), f = await c.track();
  const legacy = { ...f.inputs() }; delete legacy.template;
  await publishExport(f.slug, "youtube-16x9", legacy, async (file) => { await writeFile(file, "legacy video"); }, undefined, undefined, "after-effects");
  assert.deepEqual(f.state().staleReasons, ["template_identity_missing"]);
  assert.equal(f.state().freshness, "stale");
});

for (const problem of ["missing", "unreadable", "unconfigured"] as const) {
  test(`${problem} template cannot certify freshness or delivery and never selects Remotion`, async (t) => {
    const c = await setup(t), f = await c.track(); await f.publish();
    if (problem === "missing") await rm(c.project);
    if (problem === "unreadable") { await chmod(c.project, 0); t.after(() => chmod(c.project, 0o600).catch(() => {})); }
    if (problem === "unconfigured") await rm(c.configFile);
    const state = f.state();
    assert.equal(state.freshness, "stale"); assert.deepEqual(state.staleReasons, ["template_unavailable"]);
    assert.ok(readAfterEffectsTemplateIdentity("youtube-16x9").problem);
    const plan = await planMissingExports({ slugs: [f.slug], mode: "stale" });
    assert.equal(toRenderTargets(plan)[0].engine, "after-effects");
    const delivered = await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings: { schemaVersion: 1, root: c.dir, autoDeliver: false, autoUpdateReleaseBundle: false } });
    assert.equal(delivered.status, "outdated");
  });
}

test("mixed catalogue, detail and packages see template staleness; unrelated Remotion stays fresh", async (t) => {
  const c = await setup(t), ae = await c.track(), remotion = await c.track("remotion");
  await ae.publish(); await remotion.publish();
  await writeFile(c.project, "RIFX changed template");
  assert.equal(remotion.state().freshness, "current");
  for (const map of [toTrackDetailView, toTrackSummaryView]) assert.deepEqual(map(await inspectTrack(ae.slug)).exports[0].staleReasons, ["template_changed"]);
  for (const mode of ["stale", "missing-and-stale"] as const) {
    const plan = await planMissingExports({ slugs: [ae.slug, remotion.slug], mode });
    assert.deepEqual(toRenderTargets(plan), [{ slug: ae.slug, preset: "youtube-16x9", engine: "after-effects" }]);
  }
  const packages = await buildContentPackagesForSlugs([ae.slug, remotion.slug], { inFlight: new Map(), deliveryRoot: null, globalTemplates: null, templatesProblem: null, renderers: undefined });
  const plan = planContentPackageBatch(packages);
  assert.equal(plan.renderable.length, 1); assert.equal(plan.renderable[0].slug, ae.slug);
  assert.deepEqual(plan.renderable[0].staleReasons, ["template_changed"]);
  assert.equal(plan.ready.length, 1);
});

test("warm multi-track inspection stats the base but does not read its bytes again; replacement invalidates hash", async (t) => {
  const c = await setup(t), a = await c.track(), b = await c.track();
  await a.publish(); await b.publish();
  const original = fs.openSync;
  t.mock.method(fs, "openSync", (...args: Parameters<typeof fs.openSync>) => {
    assert.notEqual(String(args[0]), c.project, "warm inspection must not reread base bytes");
    return original(...args);
  });
  syncBuiltinESMExports();
  assert.equal(a.state().freshness, "current"); assert.equal(b.state().freshness, "current");
  t.mock.restoreAll(); syncBuiltinESMExports();
  const replacement = path.join(c.dir, "replacement");
  await writeFile(replacement, "RIFX synthetic template B"); await rename(replacement, c.project);
  assert.deepEqual(a.state().staleReasons, ["template_changed"]);
});

test("template digest is persisted and validated; no Adobe installation is needed for observation", async (t) => {
  const c = await setup(t), f = await c.track(); await f.publish();
  const output = trackOutputLocation(f.slug, "youtube-16x9", "after-effects");
  const manifest = JSON.parse(await readFile(output.manifest, "utf8"));
  assert.match(manifest.inputs.template, /^[a-f0-9]{64}$/);
  assert.equal(manifest.inputFingerprint, inputFingerprint(manifest.inputs));
  const previous = process.env.TOSHI_AERENDER_PATH; process.env.TOSHI_AERENDER_PATH = "/not-installed";
  try { assert.equal(renderEngines.status().find((s) => s.id === "after-effects")!.state, "unavailable"); assert.equal(f.state().freshness, "current"); }
  finally { if (previous === undefined) delete process.env.TOSHI_AERENDER_PATH; else process.env.TOSHI_AERENDER_PATH = previous; }
  manifest.inputs.template = 123;
  await writeFile(output.manifest, JSON.stringify(manifest));
  assert.equal(readExportManifest(output.manifest, f.slug, "youtube-16x9").reason, "manifest_invalid");
});

test("AE freshness still checks metadata, audio, cover and visualizer/brand inputs", async (t) => {
  const c = await setup(t), f = await c.track(); await f.publish();
  await writeFile(f.cover, "changed cover");
  assert.deepEqual(f.state().staleReasons, ["cover_changed"]);
  await f.publish(); await writeFile(f.beat, "changed audio");
  assert.deepEqual(f.state().staleReasons, ["audio_changed"]);
  await f.publish();
  const metadata = JSON.parse(await readFile(f.metadata, "utf8"));
  await writeFile(f.metadata, JSON.stringify({ ...metadata, title: "Changed synthetic title" }));
  assert.deepEqual(f.state().staleReasons, ["metadata_changed"]);
  await writeFile(f.metadata, JSON.stringify(metadata));
  await publishExport(f.slug, "youtube-16x9", { ...f.inputs(), visualizer: "0".repeat(64) }, async (file) => { await writeFile(file, "older visualizer/brand video"); }, undefined, undefined, "after-effects");
  assert.deepEqual(f.state().staleReasons, ["visualizer_changed"]);
});

test("replacement during hashing is rejected rather than caching the old open file as the new path", async (t) => {
  const c = await setup(t);
  const replacement = path.join(c.dir, "replacement.aep");
  await writeFile(replacement, "RIFX concurrent replacement");
  const original = fs.readSync;
  let replaced = false;
  t.mock.method(fs, "readSync", (...args: Parameters<typeof fs.readSync>) => {
    const bytes = original(...args);
    if (!replaced) { replaced = true; fs.renameSync(replacement, c.project); }
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  assert.throws(() => fileContentHash(c.project), /Input changed while fingerprinting/);
});
