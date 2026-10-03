import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import type { RendererId } from "../core/domain/video/renderers.ts";
import { DELIVERY_LOG_FILENAME } from "../core/domain/delivery/deliveryHistory.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import { readDeliveryReceipt } from "../services/delivery/deliveryReceipt.ts";
import { deliveryIdForReceipt } from "../services/delivery/deliveryHistory.ts";
import { readDeliveryLog } from "../services/delivery/deliveryHistoryLog.ts";
import { reconcileDeliveryHistory } from "../services/workflows/deliveryHistory.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { fixture } from "./fixtures.mts";

const setup = async (t: TestContext) => {
  const f = await fixture(t, { exportPresets: ["youtube-16x9"] });
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "history-renderer-")));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(f.outputDir, { recursive: true, force: true });
  });
  const settings = { schemaVersion: 1 as const, root, autoDeliver: false, autoUpdateReleaseBundle: false };
  // Simulate the supported crash/log-write-failure recovery case: the copy
  // and receipt commit, but a directory at the log path prevents recording.
  await mkdir(path.join(root, DELIVERY_LOG_FILENAME));
  const deliverWithoutHistory = async (renderer: RendererId) => {
    await updateTrackMetadata(f.slug, { renderer: renderer === "remotion" ? null : renderer });
    const metadata = (await inspectTrack(f.slug)).metadata!;
    const props = buildTrackProps({ slug: f.slug, metadata, analysisAvailable: true });
    await publishExport(f.slug, "youtube-16x9", fingerprintInputs(props, "youtube-16x9", undefined, renderer),
      async (file) => { await writeFile(file, `${renderer} video`); }, undefined, undefined, renderer);
    const outcome = await deliverExport({ slug: f.slug, presetId: "youtube-16x9", settings });
    assert.equal(outcome.status, "delivered", outcome.message ?? "");
    assert.ok(outcome.historyProblem);
    assert.ok(readDeliveryReceipt(f.slug, "youtube-16x9", renderer));
  };
  const enableHistory = () => rm(path.join(root, DELIVERY_LOG_FILENAME), { recursive: true });
  return { ...f, root, settings, deliverWithoutHistory, enableHistory };
};

for (const preferred of ["after-effects", "remotion"] as const) {
  test(`reconciliation recovers only the preferred ${preferred} receipt when both engines have receipts, exactly once`, async (t) => {
    const f = await setup(t);
    await f.deliverWithoutHistory(preferred);
    await f.deliverWithoutHistory(preferred === "after-effects" ? "remotion" : "after-effects");
    await updateTrackMetadata(f.slug, { renderer: preferred === "remotion" ? null : preferred });
    const receipt = readDeliveryReceipt(f.slug, "youtube-16x9", preferred)!;
    await f.enableHistory();
    const first = await reconcileDeliveryHistory({ settings: f.settings });
    assert.equal(first.problem, null);
    const mine = first.appended.filter((event) => event.track.slug === f.slug);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].source, "reconciled");
    assert.equal(mine[0].deliveryId, deliveryIdForReceipt(receipt));
    assert.equal(mine[0].exportFingerprint, receipt.sourceFingerprint);
    assert.equal(mine[0].deliveredAt, receipt.deliveredAt);
    const second = await reconcileDeliveryHistory({ settings: f.settings });
    assert.deepEqual(second.appended, []);
    assert.ok(second.alreadyRecorded >= 1);
    assert.equal(readDeliveryLog(f.root).events.length, 1);
  });
}

for (const oldRenderer of ["remotion", "after-effects"] as const) {
  test(`reconciliation does not substitute an old ${oldRenderer} receipt when the preferred receipt is missing`, async (t) => {
    const f = await setup(t);
    await f.deliverWithoutHistory(oldRenderer);
    const preferred = oldRenderer === "remotion" ? "after-effects" : "remotion";
    await updateTrackMetadata(f.slug, { renderer: preferred === "remotion" ? null : preferred });
    await f.enableHistory();
    const result = await reconcileDeliveryHistory({ settings: f.settings });
    assert.equal(result.appended.some((event) => event.track.slug === f.slug), false);
    assert.equal(readDeliveryLog(f.root).status, "missing");
  });
}

test("invalid metadata retains the draft's AE renderer and reports its receipt as unreconcilable", async (t) => {
  const f = await setup(t);
  await f.deliverWithoutHistory("after-effects");
  await writeFile(f.metadata, JSON.stringify({ renderer: "after-effects", title: "", artist: "Toshi", key: "F Minor", bpm: 100 }));
  await f.enableHistory();
  const result = await reconcileDeliveryHistory({ settings: f.settings });
  assert.equal(result.unreconcilable.filter((entry) => entry.slug === f.slug).length, 1);
  assert.equal(readDeliveryLog(f.root).status, "missing");
});
