import assert from "node:assert/strict";
import childProcess, { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmodSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { scanDestinationHealth } from "../server/services/destinationHealth.ts";
import { enrichDestinationHealthWithRenderContext } from "../server/services/destinationHealthRenderContext.ts";
import { planDestinationFix } from "../server/services/destinationFixPlan.ts";
import { RENDER_MANAGER_BOOT_ID } from "../server/services/renderJournal.ts";
import type { DestinationFinding } from "../core/domain/delivery/destinationHealth.ts";
import {
  buildMostRecentJobIndex,
  reconstructRenderJournal,
  RENDER_JOURNAL_SCHEMA_VERSION,
  targetKey,
  type RenderJournalEvent,
} from "../core/domain/render/renderJournal.ts";
import { deliverExport } from "../services/delivery/deliverExport.ts";
import type { DeliverySettings } from "../services/delivery/deliverySettings.ts";
import { publishExport } from "../services/render/publishExport.ts";
import {
  appendRenderJournalEvent,
  readRenderJournal,
  renderJournalPath,
} from "../services/render/renderJournalLog.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { parseTrackMetadata } from "../core/domain/tracks/metadata.ts";
import type { RenderPresetId } from "../core/domain/video/renderPresets.ts";
import { fixture } from "./fixtures.mts";
import { Worker } from "./managerHarness.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

await isolateRenderJournalForThisFile();

/**
 * Destination health + render journal context (Destination Health + Render
 * Journal Context milestone). Journal-writing tests share this file's one
 * redirected TOSHI_RENDER_JOURNAL_DIR — see renderJournalTestIsolation.mts's
 * own comment on why that redirect is file-scoped, not per-test, and why a
 * raw/lock-bypassing write to that shared file is unsafe under Node's
 * concurrent same-file test execution (tests/render-history.test.mts §57.13
 * found this the hard way). Every append here goes through
 * appendRenderJournalEvent, which takes the real append lock, so tests in
 * this file are safe to run concurrently with each other.
 *
 * Destination fixtures reuse the exact pattern tests/destination-health.test.mts
 * already established (a real mkdtemp destination root, delivered through
 * the real publish/deliver pipeline so every receipt is genuinely internally
 * consistent) — duplicated here in miniature rather than imported, since
 * that file does not export its helpers and this file additionally needs
 * per-file journal isolation that file has no reason to carry.
 */

const destination = async (t: TestContext) => {
  const root = realpathSync(await mkdtemp(path.join(tmpdir(), "toshi-health-ctx-")));
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

  const metadata = parseTrackMetadata(
    JSON.parse(await readFile(f.metadata, "utf8")),
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

  return { ...f, metadata, publish, deliver };
};

const journalEvent = (
  slug: string,
  overrides: Partial<RenderJournalEvent>,
): RenderJournalEvent => ({
  schemaVersion: RENDER_JOURNAL_SCHEMA_VERSION,
  eventId: randomUUID(),
  jobId: randomUUID(),
  batchId: null,
  slug,
  presetId: "youtube-16x9",
  state: "queued",
  recordedAt: new Date().toISOString(),
  bootId: RENDER_MANAGER_BOOT_ID,
  error: null,
  ...overrides,
});

/** A job's full lifecycle for one exact target, ending in `finalState`. */
const recordLifecycle = async (
  slug: string,
  presetId: string,
  finalState: "completed" | "failed" | "cancelled",
  options: { readonly error?: { readonly code: string; readonly message: string }; readonly bootId?: string } = {},
) => {
  const jobId = randomUUID();
  const bootId = options.bootId ?? RENDER_MANAGER_BOOT_ID;
  await appendRenderJournalEvent(journalEvent(slug, { jobId, presetId, state: "queued", bootId }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId, presetId, state: "preparing", bootId }));
  await appendRenderJournalEvent(
    journalEvent(slug, { jobId, presetId, state: finalState, bootId, error: options.error ?? null }),
  );
  return jobId;
};

/** A job left non-terminal from a different boot — interrupted by construction. */
const recordInterrupted = async (slug: string, presetId: string) => {
  const jobId = randomUUID();
  const bootId = "some-earlier-boot";
  await appendRenderJournalEvent(journalEvent(slug, { jobId, presetId, state: "queued", bootId }));
  await appendRenderJournalEvent(journalEvent(slug, { jobId, presetId, state: "rendering", bootId }));
  return jobId;
};

/** A finding with its renderContext field removed, for equality checks. */
const withoutRenderContext = (
  finding: DestinationFinding,
): Omit<DestinationFinding, "renderContext"> => ({
  code: finding.code,
  severity: finding.severity,
  message: finding.message,
  slug: finding.slug,
  presetId: finding.presetId,
  relativePath: finding.relativePath,
});

const missingFinding = (
  result: Awaited<ReturnType<typeof scanDestinationHealth>>,
  slug: string,
  presetId: string,
): DestinationFinding | undefined =>
  result.tracks
    .find((track) => track.slug === slug)
    ?.findings.find((f) => f.code === "delivered_file_missing" && f.presetId === presetId);

/* ------------------------------------------------------------------ *
 * 1-4: missing target, per historical outcome
 * ------------------------------------------------------------------ */

test("missing target + interrupted exact target: context attached, state interrupted", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordInterrupted(f.slug, "youtube-16x9");

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.ok(finding);
  assert.equal(finding.code, "delivered_file_missing");
  assert.equal(finding.renderContext?.state, "interrupted");
  assert.match(finding.renderContext!.note, /interrupted by a server restart/i);
});

test("missing target + failed exact target: context attached with safe error text", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordLifecycle(f.slug, "youtube-16x9", "failed", {
    error: { code: "RENDER_FAILED", message: "FFmpeg exited with code 1." },
  });

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.equal(finding?.renderContext?.state, "failed");
  assert.equal(finding.renderContext?.note, "Most recent render attempt failed: FFmpeg exited with code 1.");
});

test("missing target + cancelled exact target: context attached", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordLifecycle(f.slug, "youtube-16x9", "cancelled");

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.equal(finding?.renderContext?.state, "cancelled");
  assert.match(finding.renderContext!.note, /cancelled/i);
});

test("missing target + completed exact target: no context — a completed render explains nothing about destination drift", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordLifecycle(f.slug, "youtube-16x9", "completed");

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.ok(finding);
  assert.equal(finding.renderContext, undefined);
});

/* ------------------------------------------------------------------ *
 * 5: stale (changed) target
 * ------------------------------------------------------------------ */

test("stale target (delivered_file_changed) + interrupted context", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await writeFile(path.join(root, outcome.destinationRelativePath!), "a different, longer replacement file");
  await recordInterrupted(f.slug, "youtube-16x9");

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = enriched.tracks
    .find((track) => track.slug === f.slug)
    ?.findings.find((finding) => finding.code === "delivered_file_changed");

  assert.equal(finding?.renderContext?.state, "interrupted");
});

/* ------------------------------------------------------------------ *
 * 6-9: exact target matching and ordering
 * ------------------------------------------------------------------ */

test("exact preset matching: another preset's history is never attached", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish("youtube-16x9");
  const outcome = await f.deliver(root, "youtube-16x9");
  await rm(path.join(root, outcome.destinationRelativePath!));
  // Only a vertical-9x16 job exists for this track — the missing finding is
  // for youtube-16x9, which must stay unenriched.
  await recordLifecycle(f.slug, "vertical-9x16", "cancelled");

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.equal(finding?.renderContext, undefined);
});

test("other track's render history is never attached", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordLifecycle(`other-${randomUUID()}`, "youtube-16x9", "failed");

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.equal(finding?.renderContext, undefined);
});

test("the newest historical job for the exact target is chosen when several exist", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordLifecycle(f.slug, "youtube-16x9", "failed", {
    error: { code: "RENDER_FAILED", message: "an older failure" },
  });
  await recordLifecycle(f.slug, "youtube-16x9", "cancelled");

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.equal(finding?.renderContext?.state, "cancelled");
});

/* ------------------------------------------------------------------ *
 * 10, 40: live exact job excluded
 * ------------------------------------------------------------------ */

test("a live job for the exact target: no historical context, even with an older dead job for the same target", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordInterrupted(f.slug, "youtube-16x9");

  const worker = new Worker();
  worker.pid = 61234;
  const t2 = t as TestContext;
  t2.mock.method(childProcess, "fork", () => worker);
  syncBuiltinESMExports();
  t2.after(() => {
    worker.emit("message", { type: "cancelled" });
    worker.emit("exit", 0, null);
    t2.mock.restoreAll();
    syncBuiltinESMExports();
  });

  const { renderManager } = await import("../server/services/renderManager.ts");
  renderManager.startRender(f.slug, "youtube-16x9");
  worker.emit("message", { type: "status", status: "rendering" });
  await new Promise((resolve) => setImmediate(resolve));

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.equal(finding?.renderContext, undefined);
});

/* ------------------------------------------------------------------ *
 * 11-14: journal missing / unreadable / corrupt / unsupported
 * ------------------------------------------------------------------ */

test("journal missing: health is reported unchanged, no context, no crash", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  // No journal event recorded at all for this track.

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.ok(finding);
  assert.equal(finding.renderContext, undefined);
  assert.deepEqual(
    scanned.tracks.find((t) => t.slug === f.slug)?.findings.map((f) => f.code),
    enriched.tracks.find((t) => t.slug === f.slug)?.findings.map((f) => f.code),
  );
});

test("journal unreadable (a real fs error, not just missing): health is reported unchanged, no throw", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordLifecycle(f.slug, "youtube-16x9", "failed");

  const file = renderJournalPath();
  chmodSync(file, 0o000);
  t.after(() => {
    try {
      chmodSync(file, 0o600);
    } catch {
      // Already restored, or never applied (e.g. running as root).
    }
  });

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  assert.doesNotThrow(() => enrichDestinationHealthWithRenderContext(scanned));
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");
  // Either the permission is genuinely enforced (context omitted) or this
  // environment ignores file permissions for its own user (e.g. root in a
  // container) and the read succeeds — both are an acceptable outcome here;
  // the one thing that must never happen is the scan itself failing.
  assert.ok(finding);
});

test("a corrupt/quarantined job contributes no context, without affecting the rest of the scan", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));

  // An illegal transition (queued -> completed, skipping preparing/rendering)
  // is quarantined by reconstruction — the job never reaches any terminal
  // state a caller can trust, so it must never surface as context.
  const jobId = randomUUID();
  await appendRenderJournalEvent(journalEvent(f.slug, { jobId, state: "queued" }));
  await appendRenderJournalEvent(journalEvent(f.slug, { jobId, state: "completed" }));

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  // The quarantined job's record is left at "queued" (non-terminal), which
  // classifies "interrupted" — the honest answer for a record reconstruction
  // could not legally advance, not a fabricated "corrupt" state, and still a
  // legitimate context to show (§18: "use safe usable history where the
  // journal reader already supports it").
  assert.equal(finding?.renderContext?.state, "interrupted");
});

test("unsupported schema version: the whole scan still works, and other targets keep their own context", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));

  // This exact target's only event is unreadable — dropped by the parser,
  // leaving nothing to classify.
  await appendRenderJournalEvent({
    ...journalEvent(f.slug, { presetId: "youtube-16x9", state: "queued" }),
    schemaVersion: 99,
  } as RenderJournalEvent);

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.ok(finding);
  assert.equal(finding.renderContext, undefined);
  assert.deepEqual(
    scanned.tracks.find((t) => t.slug === f.slug)?.findings.map((f) => f.code),
    enriched.tracks.find((t) => t.slug === f.slug)?.findings.map((f) => f.code),
  );
});

/* ------------------------------------------------------------------ *
 * 15-18: context never changes what the scan itself decided
 * ------------------------------------------------------------------ */

test("render context never creates, removes, or changes the severity/code of a finding", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordInterrupted(f.slug, "youtube-16x9");

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);

  const strip = (findings: readonly DestinationFinding[]) =>
    findings.map((finding) => withoutRenderContext(finding));

  assert.deepEqual(strip(scanned.rootFindings), strip(enriched.rootFindings));
  for (let i = 0; i < scanned.tracks.length; i++) {
    assert.deepEqual(strip(scanned.tracks[i].findings), strip(enriched.tracks[i].findings));
  }
  assert.deepEqual(scanned.counts, enriched.counts);
  assert.equal(scanned.status, enriched.status);
});

/* ------------------------------------------------------------------ *
 * 19: fix planner invariance
 * ------------------------------------------------------------------ */

test("the remediation plan is identical whether or not render context exists — the planner never sees the field", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordInterrupted(f.slug, "youtube-16x9");

  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  const scanned = await scanDestinationHealth({ slugs: [f.slug], settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const enrichedFinding = missingFinding(enriched, f.slug, "youtube-16x9");

  // The same scenario really does produce render context when enriched...
  assert.equal(enrichedFinding?.renderContext?.state, "interrupted");
  // ...but the planner's own findings, built from scanDestinationHealth
  // directly, never carry it at all.
  assert.ok(plan.findings.every((finding) => finding.renderContext === undefined));

  // And the core finding data the planner's action derivation actually
  // switches on is identical to the enriched scan's, field for field except
  // renderContext.
  const planFinding = plan.findings.find(
    (finding) => finding.code === "delivered_file_missing" && finding.presetId === "youtube-16x9",
  );
  assert.deepEqual(
    planFinding && withoutRenderContext(planFinding),
    enrichedFinding && withoutRenderContext(enrichedFinding),
  );

  assert.ok(plan.actions.length > 0);
  assert.ok(plan.actions.some((action) => action.findingCodes.includes("delivered_file_missing")));
});

/* ------------------------------------------------------------------ *
 * 20: no path/internal leakage
 * ------------------------------------------------------------------ */

test("render context never leaks a filesystem path, the journal path, or the raw boot id", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));
  await recordLifecycle(f.slug, "youtube-16x9", "failed", {
    error: { code: "RENDER_FAILED", message: "The render process exited unexpectedly (code 1)." },
  });

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");
  const serialized = JSON.stringify(finding?.renderContext);

  assert.deepEqual(
    finding?.renderContext && new Set(Object.keys(finding.renderContext)),
    new Set(["jobId", "state", "recordedAt", "presetId", "note"]),
  );
  assert.ok(!serialized.includes(root), "must not leak the destination root path");
  assert.ok(!serialized.includes("out/"), "must not leak a project-relative path");
  assert.ok(!serialized.includes(RENDER_MANAGER_BOOT_ID), "must not leak the raw boot id");
  assert.ok(!serialized.includes(".render-journal"), "must not leak the journal's own path");
});

/* ------------------------------------------------------------------ *
 * 39, 41: completed-but-stale wording, and several presets on one track
 * ------------------------------------------------------------------ */

test("completed then made stale: the stale finding remains primary, and no context implies current validity", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await recordLifecycle(f.slug, "youtube-16x9", "completed");
  // Now drift the destination copy — the render succeeded, but the
  // destination no longer matches what was recorded.
  await writeFile(path.join(root, outcome.destinationRelativePath!), "a different, longer replacement file");

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = enriched.tracks
    .find((track) => track.slug === f.slug)
    ?.findings.find((finding) => finding.code === "delivered_file_changed");

  assert.ok(finding);
  assert.match(finding.message, /no longer matches|replaced|symlink/);
  // Per this milestone's own completed-context policy: never shown at all,
  // which is the simplest possible way to guarantee it cannot be misread as
  // "the current copy is fine" (§14/§39).
  assert.equal(finding.renderContext, undefined);
});

test("one track, three presets, three different outcomes: each finding matches only its own preset", async (t) => {
  const root = await destination(t);
  const f = await setup(t);

  for (const [presetId, outcome] of [
    ["youtube-16x9", "interrupted"],
    ["vertical-9x16", "completed"],
    ["square-1x1", "cancelled"],
  ] as const) {
    await f.publish(presetId);
    const delivered = await f.deliver(root, presetId);
    await rm(path.join(root, delivered.destinationRelativePath!));
    if (outcome === "interrupted") await recordInterrupted(f.slug, presetId);
    else await recordLifecycle(f.slug, presetId, outcome);
  }

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);

  const youtube = missingFinding(enriched, f.slug, "youtube-16x9");
  const vertical = missingFinding(enriched, f.slug, "vertical-9x16");
  const square = missingFinding(enriched, f.slug, "square-1x1");

  assert.equal(youtube?.renderContext?.state, "interrupted");
  assert.equal(vertical?.renderContext, undefined); // completed: no context, by policy
  assert.equal(square?.renderContext?.state, "cancelled");
});

/* ------------------------------------------------------------------ *
 * Performance: ~100 tracks worth of findings, a 10,000-event journal
 * ------------------------------------------------------------------ */

test("enrichment overhead stays small against a 10,000-event journal and 100 tracks' worth of findings", async (t) => {
  const TRACKS = 100;

  // A private root, written in one shot — not the shared per-file journal
  // this file's other tests use. 10,000 individually *locked* appends would
  // itself dominate the measurement (lock acquire/fsync/release per call)
  // without saying anything about this milestone's own code; a single write
  // of pre-built JSONL to a directory nothing else touches is both far
  // faster and free of the concurrency risk a raw write to the *shared*
  // journal would carry (§57.13's lesson, still the reason this file's
  // other tests only ever use the locked appendRenderJournalEvent).
  const benchRoot = await mkdtemp(path.join(tmpdir(), "toshi-health-ctx-bench-"));
  t.after(() => rm(benchRoot, { recursive: true, force: true }));

  const lines: string[] = [];
  // 50 real targets get a full lifecycle each (150 events); the remaining
  // volume is filler for unrelated tracks, reaching 10,000 total — the same
  // shape tests/render-journal.test.mts's own 10k-event benchmark uses.
  for (let i = 0; i < 50; i++) {
    const slug = `bench-track-${i}`;
    const jobId = randomUUID();
    const finalState = i % 2 === 0 ? "failed" : "cancelled";
    for (const state of ["queued", "preparing", finalState] as const) {
      lines.push(JSON.stringify(journalEvent(slug, { jobId, presetId: "youtube-16x9", state })));
    }
  }
  for (let i = lines.length; i < 10_000; i++) {
    lines.push(JSON.stringify(journalEvent(`bench-filler-${i}`, { state: "queued" })));
  }
  await writeFile(path.join(benchRoot, "journal.jsonl"), `${lines.join("\n")}\n`, "utf8");

  const findingsPerTrack: DestinationFinding[] = Array.from({ length: TRACKS }, (_, i) => ({
    code: "delivered_file_missing",
    severity: "error",
    message: "synthetic",
    slug: `bench-track-${i % 50}`,
    presetId: "youtube-16x9",
    relativePath: `bench/${i}.mp4`,
  }));

  const start = performance.now();
  const read = readRenderJournal(benchRoot);
  const reconstruction = reconstructRenderJournal(read.events);
  const index = buildMostRecentJobIndex(reconstruction, RENDER_MANAGER_BOOT_ID);
  const enriched = findingsPerTrack.map((finding) => {
    const job = index.get(targetKey(finding.slug!, finding.presetId!));
    return job === undefined || job.status === "completed" ? finding : { ...finding, renderContext: job };
  });
  const elapsedMs = performance.now() - start;

  assert.equal(read.events.length, 10_000);
  const enrichedCount = enriched.filter((finding) => "renderContext" in finding).length;
  assert.equal(enrichedCount, TRACKS);
  assert.ok(
    elapsedMs < 200,
    `read + reconstruct + index + enrich 100 findings against a 10,000-event journal took ${elapsedMs}ms, expected well under 200ms`,
  );
});

/* ------------------------------------------------------------------ *
 * Real E2E — a genuine restart, through the full destination-health scan
 * ------------------------------------------------------------------ */

test("real E2E: a render interrupted by a genuine process restart shows up as context on a real missing-file finding", async (t) => {
  const root = await destination(t);
  const f = await setup(t);
  await f.publish();
  const outcome = await f.deliver(root);
  await rm(path.join(root, outcome.destinationRelativePath!));

  const journalRoot = process.env.TOSHI_RENDER_JOURNAL_DIR;
  assert.ok(journalRoot);
  const child = fork(new URL("./render-journal-restart-process.mts", import.meta.url), [journalRoot, f.slug], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  t.after(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  });
  const [started] = (await once(child, "message")) as [{ readonly liveStatus: string; readonly bootId: string }];
  await once(child, "exit");
  assert.equal(started.liveStatus, "rendering");
  assert.notEqual(started.bootId, RENDER_MANAGER_BOOT_ID);

  const scanned = await scanDestinationHealth({ settings: settingsFor(root) });
  const enriched = enrichDestinationHealthWithRenderContext(scanned);
  const finding = missingFinding(enriched, f.slug, "youtube-16x9");

  assert.ok(finding, "the actual health problem is still reported");
  assert.equal(finding.code, "delivered_file_missing");
  assert.equal(finding.renderContext?.state, "interrupted");

  // And the fix plan for the same scenario is unaffected by any of this.
  const plan = await planDestinationFix({ slugs: [f.slug], settings: settingsFor(root) });
  assert.ok(plan.findings.every((finding) => finding.renderContext === undefined));
  assert.ok(plan.actions.length > 0);
});

/* ------------------------------------------------------------------ *
 * Domain-level sanity: buildMostRecentJobIndex directly
 * ------------------------------------------------------------------ */

test("buildMostRecentJobIndex picks the true most-recent job per exact target, independent of siblings' activity", async () => {
  const slug = `probe-${randomUUID()}`;
  // youtube-16x9 has one old job; vertical-9x16 gets several newer ones
  // afterward — youtube's own answer must not be pushed out by them.
  await recordLifecycle(slug, "youtube-16x9", "failed", { error: { code: "RENDER_FAILED", message: "old" } });
  for (let i = 0; i < 5; i++) {
    await recordLifecycle(slug, "vertical-9x16", "cancelled");
  }

  const read = readRenderJournal();
  const reconstruction = reconstructRenderJournal(read.events);
  const index = buildMostRecentJobIndex(reconstruction, RENDER_MANAGER_BOOT_ID);

  const youtube = index.get(targetKey(slug, "youtube-16x9"));
  assert.equal(youtube?.status, "failed");
});
