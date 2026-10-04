import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { RendererId } from "../core/domain/video/renderers.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import { scanDestinationHealth } from "../services/workflows/destinationHealth.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { fixture } from "./fixtures.mts";

const destination = async (t: TestContext) => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "health-renderer-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { schemaVersion: 1 as const, root, autoDeliver: false, autoUpdateReleaseBundle: false };
};

const setup = async (t: TestContext) => {
  const f = await fixture(t, { exportPresets: ["youtube-16x9"] });
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));
  const deliver = async (settings: Awaited<ReturnType<typeof destination>>, renderer: RendererId, folder?: string) => {
    await updateTrackMetadata(f.slug, { renderer: renderer === "remotion" ? null : renderer, deliveryFolder: folder ?? "" });
    const metadata = (await inspectTrack(f.slug)).metadata!;
    const props = buildTrackProps({ slug: f.slug, metadata, analysisAvailable: true });
    await publishExport(f.slug, "youtube-16x9", fingerprintInputs(props, "youtube-16x9", undefined, renderer),
      async (file) => { await writeFile(file, `${renderer} video`); }, undefined, undefined, renderer);
    const outcome = await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings });
    assert.equal(outcome.status, "delivered", outcome.message ?? "");
    return outcome.destinationPath!;
  };
  const findings = async (settings: Awaited<ReturnType<typeof destination>>) =>
    // Bundle generation is separate and remains Remotion-only. An absent
    // bundle is informational; retain every destination drift finding.
    (await scanDestinationHealth({ slugs: [f.slug], settings })).tracks[0].findings
      .filter((entry) => entry.code !== "release_bundle_missing");
  return { ...f, deliver, findings };
};

for (const firstEngine of ["remotion", "after-effects"] as const) {
  test(`an unrelated preferred receipt cannot hide a missing ${firstEngine} delivery at the scanned root`, async (t) => {
    const f = await setup(t);
    const here = await destination(t);
    const elsewhere = await destination(t);
    const file = await f.deliver(here, firstEngine);
    await f.deliver(elsewhere, firstEngine === "remotion" ? "after-effects" : "remotion");
    assert.deepEqual(await f.findings(here), [], "another renderer's root does not change the intact delivery claim");
    await rm(file);
    const findings = await f.findings(here);
    assert.ok(findings.some((entry) => entry.code === "delivered_file_missing" && entry.presetId === "youtube-16x9"));
    assert.deepEqual(await f.findings(elsewhere), []);
  });
}

test("a preferred receipt for another folder cannot shadow the matching destination path", async (t) => {
  const f = await setup(t);
  const here = await destination(t);
  const file = await f.deliver(here, "remotion");
  await f.deliver(here, "after-effects", "other-folder");
  await updateTrackMetadata(f.slug, { deliveryFolder: "" });
  await rm(file);
  assert.ok((await f.findings(here)).some((entry) => entry.code === "delivered_file_missing"));
});

test("the latest matching delivery claim wins across engines, even after preference changes", async (t) => {
  const f = await setup(t);
  const here = await destination(t);
  await f.deliver(here, "after-effects");
  const latest = await f.deliver(here, "remotion");
  await updateTrackMetadata(f.slug, { renderer: "after-effects" });
  assert.deepEqual(await f.findings(here), [], "old AE receipts must not misclassify a newer Remotion delivery as changed");
  await rm(latest);
  assert.ok((await f.findings(here)).some((entry) => entry.code === "delivered_file_missing"));
});
