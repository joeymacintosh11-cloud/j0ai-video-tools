import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { deriveContentPackage } from "../core/domain/content/contentPackage.ts";
import {
  seedPublicationMetadata,
  validatePublicationMetadata,
} from "../core/domain/publishing/publicationMetadata.ts";
import { publicationSourceFromPackage } from "../core/domain/publishing/publicationSource.ts";
import {
  canTransitionPublishJob,
  PUBLISH_JOB_STATES,
  PUBLISH_TRANSITIONS,
  transitionPublishJob,
  type PublishJob,
} from "../core/domain/publishing/publishJob.ts";
import { TrackError } from "../core/domain/tracks/errors.ts";
import { readDeliveryReceipt } from "../services/delivery/deliveryReceipt.ts";
import { readExportManifest } from "../services/tracks/exportManifest.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { toTrackDetailView } from "../services/workflows/trackView.ts";
import {
  appendPublicationReceipt,
  attemptIdentity,
  destinationWorkspace,
  readPublicationReceipts,
  readPublishJobFile,
  writePublishJobFile,
} from "../services/publishing/publishingStore.ts";
import { createPublishingService } from "../services/publishing/publishing.ts";
import { readContentLibrary } from "../services/library/contentLibraryLog.ts";
import {
  isolatePublishing,
  metadata,
  mockRegistry,
  publishingTrack,
  service,
} from "./publishingHarness.mts";

const code = (expected: string) => (error: unknown) => error instanceof TrackError && error.code === expected;
const yt = (slug: string, renderer: "remotion" | "after-effects" = "remotion") => ({ slug, presetId: "youtube-16x9" as const, renderer });
const request = (slug: string, overrides: Record<string, unknown> = {}) => ({
  destinationId: "test-mock",
  source: yt(slug),
  metadata: metadata(),
  ...overrides,
});
const publicationDirs = async (destination = "test-mock") => {
  try {
    return (await readdir(path.join(destinationWorkspace(destination), "publications"))).filter((name) => !name.startsWith("."));
  } catch {
    return [];
  }
};

/* ------------------------------------------------------------------ *
 * Registry
 * ------------------------------------------------------------------ */

test("the destination registry lists registered and reserved destinations with their state and reasons", async (t) => {
  await isolatePublishing(t);
  const { registry, knobs } = mockRegistry();
  const byId = new Map(registry.status().map((status) => [status.id, status]));
  assert.equal(byId.get("test-mock")?.state, "ready");
  assert.equal(byId.get("test-mock")?.accountId, "tester");
  assert.deepEqual(byId.get("test-landscape")?.capabilities?.formats.map((f) => f.presetId), ["youtube-16x9"]);
  assert.equal(byId.get("test-unconfigured")?.state, "not_configured");
  assert.match(byId.get("test-unconfigured")!.problem!, /account/);
  assert.equal(byId.get("test-missing")?.state, "unavailable");
  for (const reserved of ["youtube", "instagram", "tiktok"]) {
    assert.equal(byId.get(reserved)?.implemented, false);
    assert.equal(byId.get(reserved)?.state, "unavailable");
    assert.match(byId.get(reserved)!.problem!, /not implemented/);
  }
  assert.equal(knobs.loads, 0, "listing loads no adapter");
  assert.throws(() => registry.describe("myspace"), code("PUBLISH_DESTINATION_UNKNOWN"));
  assert.throws(() => registry.describe(undefined), code("PUBLISH_DESTINATION_UNKNOWN"));
  await assert.rejects(registry.resolve("youtube"), code("PUBLISH_JOB_CONFLICT"));
  await assert.rejects(registry.resolve("test-unconfigured"), /not configured|Add an account/);
  await assert.rejects(registry.resolve("nope"), code("PUBLISH_DESTINATION_UNKNOWN"));
});

test("an unknown destination fails explicitly and creates nothing; nothing is redirected", async (t) => {
  const iso = await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const { publishing } = service();
  await assert.rejects(publishing.plan(request(f.slug, { destinationId: "youtub" })), code("PUBLISH_DESTINATION_UNKNOWN"));
  await assert.rejects(publishing.createJob(request(f.slug, { destinationId: "youtub" })), code("PUBLISH_DESTINATION_UNKNOWN"));
  assert.equal(existsSync(path.join(iso.root, "jobs")), false);
  assert.deepEqual(await publicationDirs(), []);
});

/* ------------------------------------------------------------------ *
 * Validation before publishing
 * ------------------------------------------------------------------ */

test("validation: unavailable, not configured and unsupported format are blocked before publication", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion", "vertical-9x16");
  await f.render("remotion", "youtube-16x9");
  const { publishing, knobs } = service();

  const reserved = await publishing.plan(request(f.slug, { destinationId: "youtube" }));
  assert.equal(reserved.ok, false);
  assert.deepEqual(reserved.problems.map((p) => p.reason), ["destination_unavailable"]);

  const missing = await publishing.plan(request(f.slug, { destinationId: "test-missing" }));
  assert.deepEqual(missing.problems.map((p) => p.reason), ["destination_unavailable"]);

  const unconfigured = await publishing.plan(request(f.slug, { destinationId: "test-unconfigured" }));
  assert.deepEqual(unconfigured.problems.map((p) => p.reason), ["destination_not_configured"]);

  const wrongAccount = await publishing.plan(request(f.slug, { accountId: "someone-else" }));
  assert.deepEqual(wrongAccount.problems.map((p) => p.reason), ["destination_not_configured"]);

  const vertical = await publishing.plan(request(f.slug, { destinationId: "test-landscape", source: { ...yt(f.slug), presetId: "vertical-9x16" } }));
  assert.deepEqual(vertical.problems.map((p) => p.reason), ["format_unsupported"]);
  assert.match(vertical.problems[0].message, /youtube-16x9/);

  // A failed job keeps the reason, and executing it never reaches the adapter.
  const job = await publishing.createJob(request(f.slug, { destinationId: "test-landscape", source: { ...yt(f.slug), presetId: "vertical-9x16" } }));
  assert.equal(job.state, "failed");
  assert.equal(job.certainty, "not_published");
  assert.deepEqual(job.problems.map((p) => p.reason), ["format_unsupported"]);
  const retried = await publishing.execute(job.jobId);
  assert.equal(retried.state, "failed");
  assert.equal(retried.attempts.length, 0);
  assert.equal(knobs.loads, 0, "no adapter was ever loaded for a blocked publication");

  const ok = await publishing.plan(request(f.slug, { destinationId: "test-landscape" }));
  assert.equal(ok.ok, true, JSON.stringify(ok.problems));
  assert.equal(ok.mode, "video");
});

test("validation: a fresh export is accepted; missing and stale exports are rejected with their reasons", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  const { publishing } = service();

  const missing = await publishing.plan(request(f.slug));
  assert.deepEqual(missing.problems.map((p) => p.reason), ["export_missing"]);
  assert.equal(missing.source, null);
  assert.equal(missing.sourceStatus.freshness, "missing");

  const output = await f.render("remotion");
  const fresh = await publishing.plan(request(f.slug));
  assert.equal(fresh.ok, true, JSON.stringify(fresh.problems));
  const manifest = readExportManifest(output.manifest, f.slug, "youtube-16x9").manifest!;
  assert.equal(fresh.source?.inputFingerprint, manifest.inputFingerprint);
  assert.equal(fresh.source?.renderedAt, manifest.renderedAt);
  assert.equal(fresh.source?.renderer, "remotion");
  assert.equal(fresh.source?.outputLabel, `out/${f.slug}/youtube-16x9.mp4`);

  await updateTrackMetadata(f.slug, { title: "Renamed" });
  const stale = await publishing.plan(request(f.slug));
  assert.deepEqual(stale.problems.map((p) => p.reason), ["export_stale"]);
  assert.deepEqual(stale.sourceStatus.staleReasons, ["metadata_changed"]);
  const job = await publishing.createJob(request(f.slug));
  assert.equal(job.state, "failed");
  assert.equal(job.source, null);
  assert.deepEqual(await publicationDirs(), []);
});

test("validation: generic and destination-specific metadata rules are checked before publishing", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const { publishing } = service();

  const empty = await publishing.plan(request(f.slug, { metadata: { title: "  " } }));
  assert.deepEqual(empty.problems.map((p) => [p.reason, p.field]), [["publication_metadata_invalid", "title"]]);

  const bad = await publishing.plan(request(f.slug, { metadata: { title: "x", visibility: "secret", tags: "a", scheduledAt: "tomorrow", thumbnail: { path: "/etc/passwd" } } }));
  assert.deepEqual(bad.problems.map((p) => p.field).sort(), ["scheduledAt", "tags", "thumbnail", "visibility"]);

  const long = await publishing.plan(request(f.slug, { metadata: metadata({ title: "x".repeat(101) }) }));
  assert.deepEqual(long.problems.map((p) => p.reason), ["publication_metadata_invalid"]);
  assert.match(long.problems[0].message, /100/);

  const scheduled = await publishing.plan(request(f.slug, { metadata: metadata({ scheduledAt: "2030-01-01T00:00:00Z" }) }));
  assert.match(scheduled.problems[0].message, /scheduled/);

  const adapterRule = await publishing.plan(request(f.slug, { metadata: metadata({ title: "Untitled" }) }));
  assert.deepEqual(adapterRule.problems.map((p) => p.reason), ["publication_metadata_invalid"]);

  const created = await publishing.createJob(request(f.slug, { metadata: { title: "" } }));
  assert.equal(created.state, "failed");
  await assert.rejects(publishing.execute(created.jobId), /metadata is invalid/);
});

test("generic metadata validation normalises tags, visibility and schedule (data only)", () => {
  const { metadata: ok, problems } = validatePublicationMetadata({
    title: "  Title  ",
    tags: ["#lofi", "lofi", " beats ", ""],
    scheduledAt: "2030-01-01T10:00:00+02:00",
    thumbnail: { source: "track-cover" },
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(ok, {
    title: "Title",
    description: "",
    tags: ["lofi", "beats"],
    visibility: "private",
    scheduledAt: "2030-01-01T08:00:00.000Z",
    thumbnail: { source: "track-cover" },
  });
  assert.equal(validatePublicationMetadata("x").metadata, null);
  assert.equal(validatePublicationMetadata({ title: "a\u0001" }).metadata, null);
  assert.equal(validatePublicationMetadata({ title: "two\nlines" }).metadata, null);
});

/* ------------------------------------------------------------------ *
 * Renderer isolation
 * ------------------------------------------------------------------ */

test("an After Effects publication keeps its exact AE source identity, never the Remotion export", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  const remotion = await f.render("remotion", "youtube-16x9", "REMOTION BYTES");
  const ae = await f.render("after-effects", "youtube-16x9", "AFTER EFFECTS BYTES!");
  const aeManifest = readExportManifest(ae.manifest, f.slug, "youtube-16x9").manifest!;
  const remotionManifest = readExportManifest(remotion.manifest, f.slug, "youtube-16x9").manifest!;
  assert.notEqual(aeManifest.inputFingerprint, remotionManifest.inputFingerprint);
  const { publishing } = service();

  // The track's preference is Remotion (undeclared); the request names AE explicitly.
  const job = await publishing.execute((await publishing.createJob(request(f.slug, { source: yt(f.slug, "after-effects") }))).jobId);
  assert.equal(job.state, "published", JSON.stringify(job.problems));
  assert.equal(job.receipt?.source.renderer, "after-effects");
  assert.equal(job.receipt?.source.inputFingerprint, aeManifest.inputFingerprint);
  assert.equal(job.receipt?.source.outputLabel, `out/${f.slug}/after-effects/youtube-16x9.mp4`);
  const published = path.join(destinationWorkspace("test-mock"), "publications", job.receipt!.publicationId, "video.mp4");
  assert.equal(await readFile(published, "utf8"), "AFTER EFFECTS BYTES!");

  const other = await publishing.execute((await publishing.createJob(request(f.slug))).jobId);
  assert.equal(other.receipt?.source.renderer, "remotion");
  assert.equal(other.receipt?.source.inputFingerprint, remotionManifest.inputFingerprint);
  assert.equal(
    await readFile(path.join(destinationWorkspace("test-mock"), "publications", other.receipt!.publicationId, "video.mp4"), "utf8"),
    "REMOTION BYTES",
  );
  assert.equal(publishing.history({ track: f.slug, renderer: "after-effects" }).receipts.length, 1);
  assert.equal(publishing.history({ track: f.slug, renderer: "remotion" }).receipts.length, 1);
});

for (const [present, requested] of [["remotion", "after-effects"], ["after-effects", "remotion"]] as const) {
  test(`a ${requested} publication is blocked when only the ${present} export exists — never substituted`, async (t) => {
    await isolatePublishing(t);
    const f = await publishingTrack(t, present === "after-effects" ? { renderer: "after-effects" } : {});
    await f.render(present);
    const { publishing } = service();
    const plan = await publishing.plan(request(f.slug, { source: yt(f.slug, requested) }));
    assert.deepEqual(plan.problems.map((p) => p.reason), ["export_missing"]);
    assert.match(plan.problems[0].message, /never used instead/);
    const job = await publishing.execute((await publishing.createJob(request(f.slug, { source: yt(f.slug, requested) }))).jobId);
    assert.equal(job.state, "failed");
    assert.equal(job.receipt, null);
    assert.deepEqual(await publicationDirs(), []);
  });
}

test("a stale AE export is not answered by a current Remotion export of the same track and format", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("after-effects");
  await updateTrackMetadata(f.slug, { title: "Changed" });
  await f.render("remotion"); // current again for Remotion only
  const { publishing } = service();
  const ae = await publishing.plan(request(f.slug, { source: yt(f.slug, "after-effects") }));
  assert.deepEqual(ae.problems.map((p) => p.reason), ["export_stale"]);
  assert.equal(ae.source, null);
  const remotion = await publishing.plan(request(f.slug));
  assert.equal(remotion.ok, true);
});

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

test("successful mock publication: explicit lifecycle, receipt persisted, original export and records untouched", async (t) => {
  const iso = await isolatePublishing(t);
  const f = await publishingTrack(t);
  const output = await f.render("remotion");
  const before = { video: await readFile(output.path), manifest: await readFile(output.manifest, "utf8"), stat: await stat(output.path) };
  const outDirBefore = (await readdir(f.outputDir)).sort();
  const libraryBefore = readContentLibrary().records.filter((record) => record.track.slug === f.slug).length;
  const { publishing } = service();

  const created = await publishing.createJob(request(f.slug));
  assert.equal(created.state, "ready");
  assert.deepEqual(created.history.map((h) => h.state), ["pending", "validating", "ready"]);
  assert.equal(created.source?.renderer, "remotion");
  assert.equal(created.mode, "video");
  assert.equal(created.accountId, "tester");

  const job = await publishing.execute(created.jobId);
  assert.equal(job.state, "published");
  assert.equal(job.certainty, "published");
  assert.deepEqual(job.history.map((h) => h.state), ["pending", "validating", "ready", "validating", "ready", "publishing", "published"]);
  assert.equal(job.attempts.length, 1);
  assert.equal(job.attempts[0].outcome, "published");
  const receipt = job.receipt!;
  assert.equal(receipt.jobId, job.jobId);
  assert.equal(receipt.attemptId, job.attempts[0].attemptId);
  assert.equal(receipt.idempotencyKey, job.attempts[0].idempotencyKey);
  assert.deepEqual(receipt.destination, { id: "test-mock", accountId: "tester" });
  assert.match(receipt.publicationId, /^mock-[a-f0-9]{20}$/);
  assert.equal(receipt.url, `mock://test-mock/${receipt.publicationId}`);
  assert.deepEqual(receipt.source, created.source);
  assert.deepEqual(receipt.metadata, metadata());
  assert.equal(JSON.stringify(receipt).includes(iso.dir), false, "no absolute paths in a receipt");

  // Persisted separately and re-read from disk.
  const stored = readPublicationReceipts();
  assert.equal(stored.status, "complete");
  assert.deepEqual(stored.receipts, [receipt]);
  assert.deepEqual((await createPublishingService(mockRegistry().registry).getJob(job.jobId)).receipt, receipt);

  // The export, its manifest, the export folder, delivery and library records are unchanged.
  assert.deepEqual(await readFile(output.path), before.video);
  assert.equal(await readFile(output.manifest, "utf8"), before.manifest);
  assert.equal((await stat(output.path)).mtimeMs, before.stat.mtimeMs);
  assert.deepEqual((await readdir(f.outputDir)).sort(), outDirBefore);
  assert.equal(readDeliveryReceipt(f.slug, "youtube-16x9"), null);
  assert.equal(readContentLibrary().records.filter((record) => record.track.slug === f.slug).length, libraryBefore);
  assert.ok(trackExportCoverage(f.slug).find((e) => e.presetId === "youtube-16x9")?.freshness === "current");

  // Executing a published job again is refused; still exactly one receipt.
  await assert.rejects(publishing.execute(job.jobId), code("PUBLISH_JOB_CONFLICT"));
  await assert.rejects(publishing.cancel(job.jobId), code("PUBLISH_JOB_CONFLICT"));
  assert.equal(readPublicationReceipts().receipts.length, 1);
  assert.equal((await publicationDirs()).length, 1);
});

test("failed mock publication is definite, then a retry is a separate attempt with its own identity", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const { publishing, knobs } = service();
  knobs.behavior = "failure";
  const failed = await publishing.execute((await publishing.createJob(request(f.slug))).jobId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.certainty, "not_published");
  assert.deepEqual(failed.problems.map((p) => p.reason), ["publish_failed"]);
  assert.equal(failed.attempts[0].outcome, "failed");
  assert.equal(readPublicationReceipts().receipts.length, 0);

  knobs.behavior = "success";
  const retried = await publishing.execute(failed.jobId);
  assert.equal(retried.state, "published");
  assert.equal(retried.attempts.length, 2);
  const [first, second] = retried.attempts;
  assert.notEqual(first.attemptId, second.attemptId);
  assert.notEqual(first.idempotencyKey, second.idempotencyKey);
  assert.equal(second.number, 2);
  assert.equal(retried.receipt?.attemptId, second.attemptId);
  assert.deepEqual(attemptIdentity(retried.jobId, 2), { attemptId: second.attemptId, idempotencyKey: second.idempotencyKey });
});

test("cancelled mock publication: cancelling mid-publish leaves nothing published; idle jobs cancel directly", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const { publishing, knobs } = service();
  knobs.delayMs = 2_000;
  const created = await publishing.createJob(request(f.slug));
  const running = publishing.execute(created.jobId);
  await delay(100);
  assert.equal((await publishing.getJob(created.jobId)).state, "publishing");
  assert.equal((await publishing.getJob(created.jobId)).executing, true);
  const cancelled = await publishing.cancel(created.jobId);
  assert.equal(cancelled.state, "cancelled");
  assert.equal((await running).state, "cancelled");
  assert.equal(cancelled.certainty, "not_published");
  assert.equal(cancelled.attempts[0].outcome, "cancelled");
  assert.deepEqual(await publicationDirs(), []);
  assert.deepEqual(await readdir(path.join(destinationWorkspace("test-mock"), "staging")), [], "staged copy discarded");
  assert.equal(readPublicationReceipts().receipts.length, 0);
  await assert.rejects(publishing.execute(created.jobId), code("PUBLISH_JOB_CONFLICT"));

  knobs.delayMs = 0;
  const idle = await publishing.createJob(request(f.slug));
  assert.equal((await publishing.cancel(idle.jobId)).state, "cancelled");
});

test("uncertain completion fails closed to recovery_required and is settled only by reconciliation evidence", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const { publishing, knobs } = service();

  knobs.behavior = "uncertain";
  const uncertain = await publishing.execute((await publishing.createJob(request(f.slug))).jobId);
  assert.equal(uncertain.state, "recovery_required");
  assert.equal(uncertain.certainty, "uncertain");
  assert.equal(uncertain.receipt, null);
  await assert.rejects(publishing.execute(uncertain.jobId), /uncertain/);
  await assert.rejects(publishing.cancel(uncertain.jobId), code("PUBLISH_JOB_CONFLICT"));
  const recovered = await publishing.recover(uncertain.jobId);
  assert.equal(recovered.state, "published", recovered.recovery);
  assert.equal(recovered.receipt?.attemptId, uncertain.attempts[0].attemptId);
  assert.equal((await publicationDirs()).length, 1, "recovery recorded the one publication, it did not create another");

  knobs.behavior = "throw";
  const thrown = await publishing.execute((await publishing.createJob(request(f.slug))).jobId);
  assert.equal(thrown.state, "recovery_required", "an adapter that throws has not proven anything");
  const notPublished = await publishing.recover(thrown.jobId);
  assert.equal(notPublished.state, "failed");
  assert.equal(notPublished.certainty, "not_published");
  knobs.behavior = "success";
  const retried = await publishing.execute(thrown.jobId);
  assert.equal(retried.state, "published");
  assert.equal(retried.attempts.length, 2);
  await assert.rejects(publishing.recover(retried.jobId), code("PUBLISH_JOB_CONFLICT"));
});

test("a destination answer that is not a valid receipt never makes a job published", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const { publishing, knobs } = service();
  knobs.behavior = "invalid-receipt";
  const job = await publishing.execute((await publishing.createJob(request(f.slug))).jobId);
  assert.equal(job.state, "recovery_required");
  assert.deepEqual(job.problems.map((p) => p.reason), ["receipt_invalid"]);
  assert.equal(job.receiptId, null);
  assert.equal(readPublicationReceipts().receipts.length, 0);
  // Reconciliation consults the destination's own record, which is valid.
  knobs.behavior = "success";
  assert.equal((await publishing.recover(job.jobId)).state, "published");
});

test("an interrupted publishing job is reconciled: a recorded receipt means published, otherwise recovery_required", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion");
  const { publishing } = service();

  const simulateCrash = async () => {
    const ready = readPublishJobFile((await publishing.createJob(request(f.slug))).jobId);
    const identity = attemptIdentity(ready.jobId, 1);
    const crashed: PublishJob = transitionPublishJob(ready, "publishing", new Date().toISOString(), {
      attempts: [{ ...identity, number: 1, startedAt: new Date().toISOString(), finishedAt: null, outcome: null, publicationId: null, problem: null }],
    });
    await writePublishJobFile(crashed);
    return crashed;
  };

  const lost = await simulateCrash();
  const reread = await publishing.getJob(lost.jobId);
  assert.equal(reread.state, "recovery_required");
  assert.equal(reread.attempts[0].outcome, "uncertain");
  // The mock never saw it, so reconciliation proves it was not published.
  assert.equal((await publishing.recover(lost.jobId)).state, "failed");

  // Crash between receipt append and job save.
  const halfway = await simulateCrash();
  const done = await publishing.execute((await publishing.createJob(request(f.slug))).jobId);
  const attempt = halfway.attempts[0];
  await appendPublicationReceipt({
    ...done.receipt!,
    receiptId: `rcp_${attempt.idempotencyKey.slice(0, 24)}`,
    jobId: halfway.jobId,
    attemptId: attempt.attemptId,
    idempotencyKey: attempt.idempotencyKey,
    publicationId: "mock-0000000000000000000a",
    source: halfway.source!,
  });
  const listed = (await publishing.listJobs({ track: f.slug })).jobs.find((job) => job.jobId === halfway.jobId)!;
  assert.equal(listed.state, "published");
  assert.equal(listed.receipt?.publicationId, "mock-0000000000000000000a");
});

test("a job publishes its pinned export or nothing: a re-render or staleness after creation blocks it", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion", "youtube-16x9", "first");
  const { publishing } = service();
  const pinned = await publishing.createJob(request(f.slug));
  await f.render("remotion", "youtube-16x9", "second, re-rendered");
  const changed = await publishing.execute(pinned.jobId);
  assert.equal(changed.state, "failed");
  assert.deepEqual(changed.problems.map((p) => p.reason), ["source_changed"]);
  assert.deepEqual(await publicationDirs(), []);

  const stale = await publishing.createJob(request(f.slug));
  await updateTrackMetadata(f.slug, { title: "Edited" });
  const blocked = await publishing.execute(stale.jobId);
  assert.equal(blocked.state, "failed");
  assert.deepEqual(blocked.problems.map((p) => p.reason), ["export_stale"]);
  assert.equal(readPublicationReceipts().receipts.length, 0);
});

/* ------------------------------------------------------------------ *
 * Lifecycle rules
 * ------------------------------------------------------------------ */

test("publish job transitions are explicit; published requires a receipt", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const job = {
    schemaVersion: 1, jobId: "pub_000000000000000000000001", createdAt: at, updatedAt: at,
    destinationId: "test-mock", accountId: null, sourceRef: yt("a-track"), source: null, mode: null,
    metadata: metadata(), state: "pending", certainty: "not_published", problems: [], attempts: [], receiptId: null, history: [],
  } satisfies PublishJob;
  for (const from of PUBLISH_JOB_STATES)
    for (const to of PUBLISH_JOB_STATES)
      assert.equal(canTransitionPublishJob(from, to), PUBLISH_TRANSITIONS[from].includes(to));
  assert.throws(() => transitionPublishJob(job, "published", at), /cannot go from pending to published/);
  assert.throws(() => transitionPublishJob(job, "publishing", at), /cannot go/);
  const publishing = transitionPublishJob(transitionPublishJob(transitionPublishJob(job, "validating", at), "ready", at), "publishing", at);
  assert.throws(() => transitionPublishJob(publishing, "published", at), /without a validated receipt/);
  assert.equal(transitionPublishJob(publishing, "published", at, { receiptId: "rcp_x" }).state, "published");
  assert.deepEqual(PUBLISH_TRANSITIONS.published, []);
  assert.deepEqual(PUBLISH_TRANSITIONS.cancelled, []);
  assert.deepEqual(PUBLISH_TRANSITIONS.recovery_required, ["published", "failed"]);
});

/* ------------------------------------------------------------------ *
 * Content packages
 * ------------------------------------------------------------------ */

test("content-package integration: a ready platform yields an exact source and seeded metadata; packages are unchanged", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t, { renderer: "after-effects" });
  await f.render("after-effects", "youtube-16x9");
  await f.render("after-effects", "vertical-9x16");
  const derive = async () => {
    const detail = toTrackDetailView(await inspectTrack(f.slug), new Map(), null);
    return deriveContentPackage(
      { slug: detail.slug, title: detail.title, validationOk: detail.validation.ok, metadata: detail.metadata, exports: detail.exports, renderer: detail.exportsRenderer },
      { mode: "full", now: () => "fixed" },
    );
  };
  const before = await derive();
  const youtube = publicationSourceFromPackage(before, "youtube");
  assert.deepEqual(youtube, { slug: f.slug, presetId: "youtube-16x9", renderer: "after-effects" });
  assert.throws(() => publicationSourceFromPackage(before, "instagram-square"), /no current export/);
  const entry = before.platforms.find((p) => p.platformId === "youtube")!;
  const seeded = seedPublicationMetadata(entry, f.slug);
  assert.equal(seeded.title, entry.title);
  assert.equal(seeded.visibility, "private");
  const reels = seedPublicationMetadata(before.platforms.find((p) => p.platformId === "reels")!, f.slug);
  assert.equal(reels.description, before.platforms.find((p) => p.platformId === "reels")!.caption);
  assert.ok(reels.tags.every((tag) => !tag.startsWith("#")));

  const { publishing } = service();
  const job = await publishing.execute((await publishing.createJob({ destinationId: "test-mock", source: youtube, metadata: seeded })).jobId);
  assert.equal(job.state, "published", JSON.stringify(job.problems));
  assert.equal(job.receipt?.source.renderer, "after-effects");
  assert.deepEqual(await derive(), before, "publishing changes nothing a content package derives");
});

/* ------------------------------------------------------------------ *
 * Settings boundary
 * ------------------------------------------------------------------ */

test("publishing settings hold identifiers only: credentials are refused and disabled destinations are not configured", async (t) => {
  const iso = await isolatePublishing(t);
  const { publishDestinations } = await import("../adapters/publishDestinations.mts");
  const mock = () => publishDestinations.describe("local-mock");
  assert.equal(mock().state, "ready");
  assert.equal(mock().accountId, "local");
  await iso.writeSettings({ schemaVersion: 1, destinations: { "local-mock": { accountId: "studio", enabled: true } } });
  assert.equal(mock().accountId, "studio");
  await iso.writeSettings({ schemaVersion: 1, destinations: { "local-mock": { enabled: false } } });
  assert.equal(mock().state, "not_configured");
  await iso.writeSettings({ schemaVersion: 1, destinations: { "local-mock": { accessToken: "ya29.secret" } } });
  assert.equal(mock().state, "not_configured");
  assert.match(mock().problem!, /must not contain credentials/);
  assert.equal(JSON.stringify(publishDestinations.status()).includes("ya29"), false);
  await writeFile(iso.settingsFile, "{nope");
  assert.match(mock().problem!, /not valid JSON/);
});
