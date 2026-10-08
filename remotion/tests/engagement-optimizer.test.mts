import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import type { TrackDetailView } from "../core/domain/api/views.ts";
import {
  buildEngagementCaption,
  buildEngagementHooks,
  buildEngagementPlan,
  CAPTION_STYLES,
  checklistFor,
  coerceEngagementSelection,
  ENGAGEMENT_PLATFORMS,
  ENGAGEMENT_PLATFORM_GUIDANCE,
  isReadableHook,
  parseEngagementSelection,
  PLATFORM_CTAS,
  type EngagementSubject,
} from "../core/domain/content/engagementOptimizer.ts";
import { serializeTrackMetadata, validateTrackMetadata } from "../core/domain/tracks/metadata.ts";
import { handleRequest } from "../server/app.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { trackLocations } from "../services/tracks/trackLocations.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { engagementPlanFor, selectionPatch } from "../ui/components/engagementModel.ts";
import { publishingTrack } from "./publishingHarness.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

await isolateRenderJournalForThisFile();

/**
 * Engagement Optimizer: deterministic hooks, caption styles, platform CTAs
 * and the pre-export checklist (pure), the saved selection in track metadata
 * (lenient read, strict save), and proof that choosing a hook never touches
 * rendering: exports stay current and render props are unchanged.
 */

const SUBJECT: EngagementSubject = { title: "Ghetto Geek", artist: "Toshi", key: "F Minor", bpm: 100 };

/* ------------------------------------------------------------------ *
 * Hooks
 * ------------------------------------------------------------------ */

test("three distinct hooks, deterministic, each readable within about a second", () => {
  const hooks = buildEngagementHooks(SUBJECT);
  assert.deepEqual(hooks.map((hook) => hook.id), ["tease", "question", "statement"]);
  assert.deepEqual(hooks.map((hook) => hook.text), [
    "Wait for the drop… 100 BPM",
    "Does F Minor at 100 BPM hit different?",
    "Ghetto Geek — Toshi",
  ]);
  assert.equal(new Set(hooks.map((hook) => hook.text)).size, 3);
  assert.ok(hooks.every((hook) => isReadableHook(hook.text) && hook.rationale.length > 0));
  assert.deepEqual(buildEngagementHooks(SUBJECT), hooks, "same track, same suggestions");
});

test("hooks fall back to shorter wording rather than exceed a one-second read, and use the subtitle when there is one", () => {
  const long = { ...SUBJECT, title: "An Extremely Long Working Title For This Particular Late Night Session" };
  const statement = buildEngagementHooks(long).find((hook) => hook.id === "statement")!;
  assert.equal(statement.text, "New Toshi beat");
  assert.ok(buildEngagementHooks(long).every((hook) => isReadableHook(hook.text)));

  const withSubtitle = buildEngagementHooks({ ...SUBJECT, subtitle: "  Made at 3am  " });
  assert.equal(withSubtitle.find((hook) => hook.id === "statement")!.text, "Made at 3am.");
});

/* ------------------------------------------------------------------ *
 * Captions and CTAs
 * ------------------------------------------------------------------ */

test("every caption opens with the hook and carries its platform's CTA and hashtag guidance", () => {
  const [hook] = buildEngagementHooks({ ...SUBJECT, artist: "Toshi Beats", key: "F# Minor" });
  for (const platform of ENGAGEMENT_PLATFORMS) {
    for (const style of CAPTION_STYLES) {
      const caption = buildEngagementCaption({ ...SUBJECT, artist: "Toshi Beats", key: "F# Minor" }, hook, platform, style);
      assert.equal(caption.text.split("\n")[0], hook.text, `${platform}/${style} opens with the hook`);
      assert.equal(caption.cta, PLATFORM_CTAS[platform][style]);
      assert.ok(caption.text.includes(caption.cta));
      assert.ok(caption.hashtags.length >= 1 && caption.hashtags.length <= ENGAGEMENT_PLATFORM_GUIDANCE[platform].recommendedMaxHashtags);
      assert.ok(caption.hashtags.every((tag) => /^[\p{L}\p{N}_]+$/u.test(tag)), `${caption.hashtags} are postable hashtags`);
      assert.ok(caption.text.endsWith(caption.hashtags.map((tag) => `#${tag}`).join(" ")));
    }
  }
  const shorts = buildEngagementCaption(SUBJECT, hook, "youtube-shorts", "discovery");
  assert.equal(shorts.hashtags[0], "Shorts");
  const discovery = buildEngagementCaption({ ...SUBJECT, artist: "Toshi Beats", key: "F# Minor" }, hook, "tiktok", "discovery");
  assert.deepEqual(discovery.hashtags, ["TypeBeat", "100BPM", "FSharpMinor", "Producer", "ToshiBeats"]);
});

test("the three styles differ in intent, and CTAs are specific to each platform", () => {
  const [hook] = buildEngagementHooks(SUBJECT);
  const bodies = CAPTION_STYLES.map((style) => buildEngagementCaption(SUBJECT, hook, "instagram-reels", style).text);
  assert.equal(new Set(bodies).size, 3);
  assert.match(bodies[0], /which part hits hardest\?/);
  assert.match(bodies[1], /F Minor · 100 BPM/);
  assert.match(bodies[2], /out now/);
  for (const style of CAPTION_STYLES) {
    assert.equal(new Set(ENGAGEMENT_PLATFORMS.map((platform) => PLATFORM_CTAS[platform][style])).size >= 2, true, style);
  }
  assert.equal(PLATFORM_CTAS.tiktok.discovery, "Use this sound in your next video.");
});

/* ------------------------------------------------------------------ *
 * Checklist
 * ------------------------------------------------------------------ */

test("the checklist fails without a hook, passes a complete post, and warns on a missing or stale 9:16 export", () => {
  const status = (items: ReturnType<typeof checklistFor>) => Object.fromEntries(items.map((item) => [item.id, item.status]));

  const unchosen = buildEngagementPlan({ subject: SUBJECT, platform: "tiktok", verticalExport: { intended: true, freshness: "current" } })!;
  assert.equal(unchosen.selectedHook, null);
  assert.equal(status(unchosen.checklist).hook_selected, "fail");
  assert.equal(status(unchosen.checklist).hook_readable, undefined);

  const chosen = buildEngagementPlan({
    subject: SUBJECT,
    selection: { hook: "question", captionStyle: "conversion" },
    platform: "youtube-shorts",
    verticalExport: { intended: true, freshness: "current" },
  })!;
  assert.equal(chosen.captions.conversion.firstLine, "Does F Minor at 100 BPM hit different?");
  assert.deepEqual(status(chosen.checklist), {
    metadata_complete: "pass",
    hook_selected: "pass",
    hook_readable: "pass",
    first_line_visible: "pass",
    cta_present: "pass",
    hashtags: "pass",
    caption_length: "pass",
    vertical_export: "pass",
  });

  const facts = (intended: boolean, freshness: "current" | "stale" | "missing") =>
    status(buildEngagementPlan({ subject: SUBJECT, selection: { hook: "tease" }, platform: "instagram-reels", verticalExport: { intended, freshness } })!.checklist).vertical_export;
  assert.equal(facts(true, "stale"), "warn");
  assert.equal(facts(true, "missing"), "warn");
  assert.equal(facts(false, "current"), "warn");

  const unreadable = checklistFor({
    subject: SUBJECT,
    selectedHook: { id: "tease", label: "x", rationale: "x", text: "one two three four five six seven eight nine ten" },
    caption: null,
    verticalExport: null,
  });
  assert.equal(status(unreadable).hook_readable, "warn");
  assert.equal(status(checklistFor({ subject: null, selectedHook: null, caption: null, verticalExport: null })).metadata_complete, "fail");
  assert.equal(buildEngagementPlan({ subject: null, platform: "tiktok" }), null);
});

/* ------------------------------------------------------------------ *
 * The saved selection
 * ------------------------------------------------------------------ */

test("a stored selection is read leniently and a requested one strictly", () => {
  assert.deepEqual(coerceEngagementSelection({ hook: "question", captionStyle: "discovery" }), { hook: "question", captionStyle: "discovery" });
  assert.deepEqual(coerceEngagementSelection({ hook: "clickbait", captionStyle: "discovery" }), { captionStyle: "discovery" });
  assert.equal(coerceEngagementSelection({ hook: 7 }), undefined);
  assert.equal(coerceEngagementSelection("question"), undefined);

  assert.deepEqual(parseEngagementSelection({ hook: "tease" }), { selection: { hook: "tease" }, problems: [] });
  assert.deepEqual(parseEngagementSelection(null), { selection: null, problems: [] });
  assert.equal(parseEngagementSelection({ hook: "clickbait", extra: 1 }).problems.length, 2);
  assert.equal(parseEngagementSelection([]).problems.length, 1);

  // An unknown stored value never makes the track invalid (it could not render otherwise).
  const valid = validateTrackMetadata({ title: "T", artist: "A", key: "C Major", bpm: 90, engagement: { hook: "clickbait" } }, "metadata.json");
  assert.deepEqual(valid.issues, []);
  assert.equal(valid.metadata!.engagement, undefined);
  const kept = validateTrackMetadata({ title: "T", artist: "A", key: "C Major", bpm: 90, engagement: { hook: "tease" } }, "metadata.json");
  assert.deepEqual(kept.metadata!.engagement, { hook: "tease" });
  assert.match(serializeTrackMetadata(kept.metadata!), /"engagement": \{\n {4}"hook": "tease"\n {2}\}\n\}\n$/);
  assert.doesNotMatch(serializeTrackMetadata({ title: "T", artist: "A", key: "C", bpm: 90 }), /engagement/);
});

test("choosing a hook is saved with the track and leaves every export current", async (t) => {
  const f = await publishingTrack(t);
  await f.render("remotion", "vertical-9x16");
  await f.render("remotion", "youtube-16x9");
  const before = trackExportCoverage(f.slug).map((facts) => [facts.presetId, facts.freshness, facts.inputFingerprint]);
  assert.deepEqual(before.filter(([, freshness]) => freshness === "current").length, 2);

  const saved = await updateTrackMetadata(f.slug, { engagement: { hook: "question", captionStyle: "conversion" } });
  assert.deepEqual(saved.metadata.engagement, { hook: "question", captionStyle: "conversion" });
  const onDisk = JSON.parse(await readFile(trackLocations(f.slug).metadata, "utf8"));
  assert.deepEqual(onDisk.engagement, { hook: "question", captionStyle: "conversion" });

  // Unrelated saves keep the choice; null clears it.
  await updateTrackMetadata(f.slug, { subtitle: "" });
  assert.deepEqual(JSON.parse(await readFile(trackLocations(f.slug).metadata, "utf8")).engagement, { hook: "question", captionStyle: "conversion" });
  assert.deepEqual(trackExportCoverage(f.slug).map((facts) => [facts.presetId, facts.freshness, facts.inputFingerprint]), before);

  await updateTrackMetadata(f.slug, { engagement: null });
  assert.equal(JSON.parse(await readFile(trackLocations(f.slug).metadata, "utf8")).engagement, undefined);
  assert.deepEqual(trackExportCoverage(f.slug).map((facts) => [facts.presetId, facts.freshness, facts.inputFingerprint]), before);
});

/* ------------------------------------------------------------------ *
 * HTTP and the panel model
 * ------------------------------------------------------------------ */

const api = async (t: TestContext) => {
  const server = createServer((req, res) => {
    void handleRequest(req, res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
};

test("PATCH metadata accepts a valid engagement choice with its revision and refuses an invalid one", async (t) => {
  const f = await publishingTrack(t);
  const base = await api(t);
  const url = `${base}/api/tracks/${f.slug}`;
  const patch = (body: unknown, revision?: string) =>
    fetch(`${url}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...(revision ? { "if-match": `"${revision}"` } : {}) },
      body: JSON.stringify(body),
    });

  const initial = (await (await fetch(url)).json()).data;
  const bad = await patch({ engagement: { hook: "clickbait" } }, initial.metadataRevision);
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "INVALID_REQUEST");

  const ok = await patch(selectionPatch(undefined, { hook: "tease" }), initial.metadataRevision);
  assert.equal(ok.status, 200);
  const detail = (await ok.json()).data as TrackDetailView;
  assert.deepEqual(detail.metadata!.engagement, { hook: "tease", captionStyle: "engagement" });

  // A stale revision is refused like any other metadata save.
  const stale = await patch(selectionPatch(detail.metadata!.engagement, { captionStyle: "discovery" }), initial.metadataRevision);
  assert.equal(stale.status, 412);

  const plan = engagementPlanFor(detail, "tiktok")!;
  assert.equal(plan.selectedHook!.id, "tease");
  assert.equal(plan.captionStyle, "engagement");
  assert.ok(plan.checklist.some((item) => item.id === "vertical_export"));
});

test("panel model: the plan follows the track's details and saved choice; a patch keeps the other half of the selection", () => {
  assert.equal(engagementPlanFor({ metadata: null, exports: [] }, "tiktok"), null);

  const track = {
    metadata: { title: "Probe", artist: "Toshi", key: "C Major", bpm: 90, exportPresets: ["youtube-16x9"], engagement: { captionStyle: "discovery" } },
    exports: [{ presetId: "vertical-9x16", freshness: "missing" }],
  } as unknown as TrackDetailView;
  const plan = engagementPlanFor(track, "instagram-reels")!;
  assert.equal(plan.selectedHook, null);
  assert.equal(plan.captionStyle, "discovery");
  assert.equal(plan.checklist.find((item) => item.id === "vertical_export")!.status, "warn");
  assert.match(plan.checklist.find((item) => item.id === "vertical_export")!.detail, /not one of this track's export formats/);

  assert.deepEqual(selectionPatch({ hook: "question", captionStyle: "conversion" }, { captionStyle: "discovery" }), {
    engagement: { hook: "question", captionStyle: "discovery" },
  });
  assert.deepEqual(selectionPatch(undefined, { captionStyle: "conversion" }), { engagement: { captionStyle: "conversion" } });
});
