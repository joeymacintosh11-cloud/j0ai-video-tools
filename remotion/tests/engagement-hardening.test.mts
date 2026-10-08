import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import test, { type TestContext } from "node:test";
import type { TrackDetailView } from "../core/domain/api/views.ts";
import {
  buildEngagementCaption,
  buildEngagementHooks,
  buildEngagementPlan,
  characterCount,
  isReadableHook,
  keyHashtagOf,
  parseEngagementSelection,
  type CaptionStyle,
  type EngagementHookId,
  type EngagementSelection,
} from "../core/domain/content/engagementOptimizer.ts";
import { validateTrackMetadata } from "../core/domain/tracks/metadata.ts";
import { handleRequest } from "../server/app.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import { trackLocations } from "../services/tracks/trackLocations.ts";
import { updateTrackMetadata } from "../services/tracks/updateTrackMetadata.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { toTrackDetailView } from "../services/workflows/trackView.ts";
import {
  engagementSyncReducer,
  engagementSyncView,
  INITIAL_ENGAGEMENT_SYNC,
  nextTabIndex,
  selectionPatch,
  type EngagementSync,
} from "../ui/components/engagementModel.ts";
import { decideSeed } from "../ui/components/metadataSeed.ts";
import { publishingTrack } from "./publishingHarness.mts";
import { isolateRenderJournalForThisFile } from "./renderJournalTestIsolation.mts";

await isolateRenderJournalForThisFile();

/**
 * Hardening for Engagement Optimizer V1 (review P2s): the panel's save/refresh
 * coordination, preservation and strict validation of `engagement` in
 * metadata.json, export freshness for both renderers, HTTP clear/replace, and
 * the copy generators' edge cases (accidentals, punctuation, Unicode,
 * hashtag collisions).
 *
 * The panel scenarios drive engagementSyncReducer exactly as EngagementPanel
 * does — the component is a thin binding over it — against the *real*
 * metadata service, so revisions and 412 conflicts are genuine. A refresh is
 * modelled by when the "prop" (the parent's track view) is re-read.
 */

const detailOf = async (slug: string): Promise<TrackDetailView> => toTrackDetailView(await inspectTrack(slug));

const errorCode = (code: string) => (error: unknown) => (error as { issue?: { code?: string } }).issue?.code === code;

/** EngagementPanel's choose(), step by step, with the refresh under test control. */
const panel = async (slug: string) => {
  let state: EngagementSync = INITIAL_ENGAGEMENT_SYNC;
  let prop = await detailOf(slug);
  let requests = 0;
  const dispatch = (action: Parameters<typeof engagementSyncReducer>[1]) => {
    state = engagementSyncReducer(state, action);
  };
  const view = () => engagementSyncView(state, prop);

  return {
    view,
    get prop() {
      return prop;
    },
    /** The parent re-reads the track (the refresh that follows a save, or a window-focus one). */
    refresh: async () => {
      prop = await detailOf(slug);
      dispatch({ type: "synced", slug: prop.slug, revision: prop.metadataRevision });
    },
    /** A refresh whose result is an earlier read, landing late. */
    showStale: (stale: TrackDetailView) => {
      prop = stale;
      dispatch({ type: "synced", slug: stale.slug, revision: stale.metadataRevision });
    },
    switchTo: async (other: string) => {
      prop = await detailOf(other);
      dispatch({ type: "synced", slug: prop.slug, revision: prop.metadataRevision });
    },
    /** A click: refused while this track has a save in flight, else sent against the view's revision. */
    begin: (change: { readonly hook?: EngagementHookId; readonly captionStyle?: CaptionStyle }) => {
      const v = view();
      if (v.locked) return null;
      const requestId = ++requests;
      const from = prop.slug;
      dispatch({ type: "started", slug: from, requestId });
      const base = v.revision;
      const sent = updateTrackMetadata(from, selectionPatch(v.engagement, change), base ?? undefined);
      return {
        settle: async () => {
          try {
            const saved = await sent;
            const detail = await detailOf(from);
            dispatch({
              type: "succeeded",
              slug: from,
              requestId,
              baseRevision: base,
              currentSlug: prop.slug,
              currentRevision: prop.metadataRevision,
              revision: detail.metadataRevision,
              engagement: saved.metadata.engagement,
            });
            return "saved" as const;
          } catch (error) {
            dispatch({ type: "failed", slug: from, requestId, conflict: errorCode("METADATA_CONFLICT")(error) });
            return (error as { issue?: { code?: string } }).issue?.code ?? "error";
          }
        },
      };
    },
  };
};

const onDisk = async (slug: string) => JSON.parse(await readFile(trackLocations(slug).metadata, "utf8"));

/* ------------------------------------------------------------------ *
 * P1 — save/refresh coordination
 * ------------------------------------------------------------------ */

test("rapid hook changes: a click during a save is refused, and every later save uses the confirmed revision, not the lagging one", async (t) => {
  const f = await publishingTrack(t);
  const p = await panel(f.slug);

  const first = p.begin({ hook: "tease" })!;
  assert.equal(p.view().locked, true);
  assert.equal(p.begin({ hook: "question" }), null, "refused while the first save is in flight");
  assert.equal(await first.settle(), "saved");

  // The parent's refresh has not arrived: the prop still shows the old revision.
  assert.equal(p.view().locked, false);
  assert.deepEqual(p.view().engagement, { hook: "tease", captionStyle: "engagement" }, "shows the saved choice, not the stale prop");
  assert.notEqual(p.view().revision, p.prop.metadataRevision);

  for (const hook of ["question", "statement", "tease", "question"] as const) {
    assert.equal(await p.begin({ hook })!.settle(), "saved", `${hook} saved without a 412`);
  }
  assert.deepEqual((await onDisk(f.slug)).engagement, { hook: "question", captionStyle: "engagement" });
  assert.deepEqual(p.view().engagement, { hook: "question", captionStyle: "engagement" });

  await p.refresh();
  assert.equal(p.view().revision, p.prop.metadataRevision, "the prop has caught up and is the truth again");
  assert.equal(await p.begin({ captionStyle: "discovery" })!.settle(), "saved");
});

test("a failed or late refresh never shows an older choice or sends a stale revision", async (t) => {
  const f = await publishingTrack(t);
  const p = await panel(f.slug);
  const original = p.prop;

  assert.equal(await p.begin({ hook: "tease" })!.settle(), "saved");
  const afterFirst = await detailOf(f.slug);
  assert.equal(await p.begin({ hook: "statement" })!.settle(), "saved");

  // The first save's refresh lands after the second save: it is late, not news.
  p.showStale(afterFirst);
  assert.deepEqual(p.view().engagement, { hook: "statement", captionStyle: "engagement" });
  // An even older read (a focus refresh started before any save) lands too.
  p.showStale(original);
  assert.deepEqual(p.view().engagement, { hook: "statement", captionStyle: "engagement" });
  // The refresh never succeeds, yet saving still works against the confirmed revision.
  assert.equal(await p.begin({ captionStyle: "conversion" })!.settle(), "saved");
  assert.deepEqual((await onDisk(f.slug)).engagement, { hook: "statement", captionStyle: "conversion" });
});

test("a save failure unlocks without inventing state; a conflict from another writer hands control back to the prop", async (t) => {
  const f = await publishingTrack(t);
  const p = await panel(f.slug);
  assert.equal(await p.begin({ hook: "tease" })!.settle(), "saved");

  // Another writer (Track Info, a script) saves before this panel's refresh.
  await updateTrackMetadata(f.slug, { subtitle: "Edited elsewhere" });
  const conflicted = p.begin({ hook: "question" })!;
  assert.equal(await conflicted.settle(), "METADATA_CONFLICT");
  assert.equal(p.view().locked, false);
  assert.deepEqual((await onDisk(f.slug)).engagement, { hook: "tease", captionStyle: "engagement" }, "nothing was overwritten");

  // The refresh a conflict triggers brings the other writer's revision; the next click succeeds.
  await p.refresh();
  assert.equal(p.view().revision, p.prop.metadataRevision);
  assert.equal(await p.begin({ hook: "question" })!.settle(), "saved");
  assert.equal((await onDisk(f.slug)).subtitle, "Edited elsewhere");
});

test("switching track during a save: the other track is never locked or overwritten, and the late result is dropped", async (t) => {
  const a = await publishingTrack(t);
  const b = await publishingTrack(t);
  const p = await panel(a.slug);

  const pending = p.begin({ hook: "tease" })!;
  await p.switchTo(b.slug);
  assert.equal(p.view().locked, false, "track B is not locked by track A's save");
  assert.equal(p.view().engagement, undefined, "track B shows its own (empty) choice");

  assert.equal(await pending.settle(), "saved");
  assert.equal(p.view().engagement, undefined, "A's result is not shown under B");
  assert.equal((await onDisk(b.slug)).engagement, undefined);
  assert.deepEqual((await onDisk(a.slug)).engagement, { hook: "tease", captionStyle: "engagement" });

  assert.equal(await p.begin({ hook: "statement" })!.settle(), "saved");
  assert.deepEqual((await onDisk(b.slug)).engagement, { hook: "statement", captionStyle: "engagement" });
  await p.switchTo(a.slug);
  assert.deepEqual(p.view().engagement, { hook: "tease", captionStyle: "engagement" });
});

test("reducer: results for an unknown request are ignored, and a non-conflict failure keeps the confirmed state", () => {
  const started = engagementSyncReducer(INITIAL_ENGAGEMENT_SYNC, { type: "started", slug: "a", requestId: 1 });
  assert.equal(engagementSyncReducer(started, { type: "failed", slug: "a", requestId: 2, conflict: false }), started);
  const confirmed = engagementSyncReducer(started, {
    type: "succeeded", slug: "a", requestId: 1, baseRevision: "r0", currentSlug: "a", currentRevision: "r0", revision: "r1", engagement: { hook: "tease" },
  });
  const again = engagementSyncReducer(confirmed, { type: "started", slug: "a", requestId: 2 });
  const failed = engagementSyncReducer(again, { type: "failed", slug: "a", requestId: 2, conflict: false });
  assert.deepEqual(failed.confirmed, confirmed.confirmed);
  assert.equal(failed.saving, null);
  assert.equal(engagementSyncReducer(again, { type: "failed", slug: "a", requestId: 2, conflict: true }).confirmed, null);
});

/* ------------------------------------------------------------------ *
 * Unsaved Track Info edits
 * ------------------------------------------------------------------ */

test("an engagement save under unsaved Track Info edits no longer forces a conflict: the form rebases and its save keeps both", async (t) => {
  const f = await publishingTrack(t);
  const seededFrom = await detailOf(f.slug);

  // The form has an unsaved title edit; meanwhile the Engagement panel saves.
  await updateTrackMetadata(f.slug, { engagement: { hook: "question" } }, seededFrom.metadataRevision ?? undefined);
  const refreshed = await detailOf(f.slug);
  assert.notEqual(refreshed.metadataRevision, seededFrom.metadataRevision);
  // Nothing the form shows changed, so it rebases instead of warning.
  assert.equal(decideSeed({ switchedTrack: false, revisionChanged: true, dirty: true, formFieldsChanged: false }), "rebase");

  await updateTrackMetadata(f.slug, { title: "Retitled in Track Info" }, refreshed.metadataRevision ?? undefined);
  const saved = await onDisk(f.slug);
  assert.equal(saved.title, "Retitled in Track Info");
  assert.deepEqual(saved.engagement, { hook: "question" });

  // A change to a field the form shows still keeps the edit and warns, as before.
  assert.equal(decideSeed({ switchedTrack: false, revisionChanged: true, dirty: true, formFieldsChanged: true }), "keep-local-edits");
  assert.equal(decideSeed({ switchedTrack: false, revisionChanged: true, dirty: true }), "keep-local-edits", "unknown counts as changed");
  assert.equal(decideSeed({ switchedTrack: false, revisionChanged: true, dirty: false, formFieldsChanged: false }), "reseed");
});

/* ------------------------------------------------------------------ *
 * P2/P3 — preservation and service-level validation
 * ------------------------------------------------------------------ */

test("an unknown stored engagement value survives unrelated saves byte for byte, and still reads leniently", async (t) => {
  const f = await publishingTrack(t);
  const file = trackLocations(f.slug).metadata;
  const future = { hook: "countdown", captionStyle: "discovery", hookTextOverride: "Ünïcode ✓", weights: [1, 2] };
  await writeFile(file, JSON.stringify({ ...(await onDisk(f.slug)), engagement: future }, null, 2));

  const read = validateTrackMetadata(await onDisk(f.slug), "metadata.json");
  assert.deepEqual(read.issues, []);
  assert.deepEqual(read.metadata!.engagement, { captionStyle: "discovery" }, "lenient: what this version understands");

  await updateTrackMetadata(f.slug, { subtitle: "Unrelated" });
  await updateTrackMetadata(f.slug, { exportPresets: ["vertical-9x16"] });
  await updateTrackMetadata(f.slug, { contentMetadataOverrides: null });
  assert.deepEqual((await onDisk(f.slug)).engagement, future);

  // Only an explicit engagement patch replaces it.
  await updateTrackMetadata(f.slug, { engagement: { hook: "tease" } });
  assert.deepEqual((await onDisk(f.slug)).engagement, { hook: "tease" });
});

test("the service refuses malformed engagement patches and never clears a saved choice with one", async (t) => {
  const f = await publishingTrack(t);
  await updateTrackMetadata(f.slug, { engagement: { hook: "question", captionStyle: "conversion" } });
  const before = await readFile(trackLocations(f.slug).metadata, "utf8");

  for (const bad of [{ hook: "clickbait" }, {}, { captionStyle: 3 }, { hook: "tease", extra: true }, "tease", []]) {
    await assert.rejects(
      updateTrackMetadata(f.slug, { engagement: bad as unknown as EngagementSelection }),
      errorCode("INVALID_REQUEST"),
      JSON.stringify(bad),
    );
  }
  assert.equal(await readFile(trackLocations(f.slug).metadata, "utf8"), before, "file untouched by every refusal");
  assert.deepEqual(parseEngagementSelection({}).problems.length, 1);

  await updateTrackMetadata(f.slug, { engagement: null });
  assert.equal((await onDisk(f.slug)).engagement, undefined, "null is the one way to clear");
});

/* ------------------------------------------------------------------ *
 * Export freshness, both renderers
 * ------------------------------------------------------------------ */

test("engagement saves leave Remotion and After Effects exports current with identical fingerprints", async (t) => {
  const f = await publishingTrack(t);
  await f.render("remotion", "vertical-9x16");
  await f.render("remotion", "youtube-16x9");
  await f.render("after-effects", "vertical-9x16");
  await f.render("after-effects", "youtube-16x9");
  const facts = () =>
    (["remotion", "after-effects"] as const).flatMap((renderer) =>
      trackExportCoverage(f.slug, undefined, renderer)
        .filter((entry) => entry.rendered)
        .map((entry) => [renderer, entry.presetId, entry.freshness, entry.inputFingerprint]),
    );
  const before = facts();
  assert.equal(before.length, 4);
  assert.ok(before.every(([, , freshness]) => freshness === "current"), JSON.stringify(before));

  await updateTrackMetadata(f.slug, { engagement: { hook: "tease", captionStyle: "discovery" } });
  assert.deepEqual(facts(), before);
  await updateTrackMetadata(f.slug, { engagement: { hook: "question" } });
  assert.deepEqual(facts(), before);
  await updateTrackMetadata(f.slug, { engagement: null });
  assert.deepEqual(facts(), before);
});

/* ------------------------------------------------------------------ *
 * HTTP clear and replace
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

test("HTTP: an engagement object replaces the whole selection, null clears it, and invalid input changes nothing", async (t) => {
  const f = await publishingTrack(t);
  const base = await api(t);
  const patch = async (body: unknown) => {
    const response = await fetch(`${base}/api/tracks/${f.slug}/metadata`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await patch({ engagement: { hook: "tease", captionStyle: "discovery" } })).status, 200);
  const replaced = await patch({ engagement: { hook: "question" } });
  assert.deepEqual(replaced.body.data.metadata.engagement, { hook: "question" }, "replaced, not merged");
  assert.deepEqual((await onDisk(f.slug)).engagement, { hook: "question" });

  for (const bad of [{}, { hook: "clickbait" }, "question"]) {
    const refused = await patch({ engagement: bad });
    assert.equal(refused.status, 400, JSON.stringify(bad));
    assert.equal(refused.body.error.code, "INVALID_REQUEST");
  }
  assert.deepEqual((await onDisk(f.slug)).engagement, { hook: "question" });

  const cleared = await patch({ engagement: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.data.metadata.engagement, undefined);
  assert.equal((await onDisk(f.slug)).engagement, undefined);
});

/* ------------------------------------------------------------------ *
 * Copy generators: accidentals, punctuation, Unicode, collisions
 * ------------------------------------------------------------------ */

const SUBJECT = { title: "Ghetto Geek", artist: "Toshi", key: "F# Minor", bpm: 100 };

test("accidentals survive: F# Minor is #FSharpMinor in hashtags and F# Minor in hooks", () => {
  assert.equal(keyHashtagOf("F# Minor"), "FSharpMinor");
  assert.equal(keyHashtagOf("F♯ Minor"), "FSharpMinor");
  assert.equal(keyHashtagOf("B♭ Major"), "BFlatMajor");
  assert.equal(keyHashtagOf("Bb Major"), "BbMajor");
  assert.notEqual(keyHashtagOf("F# Minor"), keyHashtagOf("F Minor"));
  const question = buildEngagementHooks(SUBJECT).find((hook) => hook.id === "question")!;
  assert.equal(question.text, "Does F# Minor at 100 BPM hit different?");
  const [hook] = buildEngagementHooks(SUBJECT);
  assert.ok(buildEngagementCaption(SUBJECT, hook, "tiktok", "discovery").hashtags.includes("FSharpMinor"));
});

test("hooks never double their punctuation", () => {
  for (const [subtitle, expected] of [
    ["Made at 3am", "Made at 3am."],
    ["Made at 3am.", "Made at 3am."],
    ["Ready?", "Ready?"],
    ["Wow!", "Wow!"],
    ["To be continued…", "To be continued…"],
  ] as const) {
    assert.equal(buildEngagementHooks({ ...SUBJECT, subtitle }).find((hook) => hook.id === "statement")!.text, expected);
  }
  for (const hook of buildEngagementHooks({ ...SUBJECT, subtitle: "Late." })) assert.doesNotMatch(hook.text, /([.!?…])\1|\.…|…\./u);
});

test("Unicode: characters are counted as readers count them, at the readable-hook boundary and in captions", () => {
  assert.equal(characterCount("🎧"), 1);
  assert.equal(characterCount("東京"), 2);
  const fifty = `${"🎧".repeat(25)}${"x".repeat(25)}`;
  assert.equal(fifty.length, 75, "75 UTF-16 units…");
  assert.equal(isReadableHook(fifty), true, "…but 50 characters, so still readable");
  assert.equal(isReadableHook(`${fifty}y`), false);

  const unicode = { title: "Nachtfahrt 🌙", artist: "Café 東京 🎧", key: "C♯ Minor", bpm: 88 };
  const plan = buildEngagementPlan({ subject: unicode, selection: { hook: "statement", captionStyle: "discovery" }, platform: "instagram-reels" })!;
  assert.equal(plan.selectedHook!.text, "Nachtfahrt 🌙 — Café 東京 🎧");
  assert.deepEqual(plan.captions.discovery.hashtags, ["TypeBeat", "88BPM", "CSharpMinor", "Producer", "Café東京"]);
  const firstLine = plan.checklist.find((item) => item.id === "first_line_visible")!;
  assert.match(firstLine.detail, new RegExp(`^${characterCount(plan.selectedHook!.text)} of`));
});

test("long text: hooks fall back to a readable form and an over-long caption fails the checklist", () => {
  const long = { ...SUBJECT, title: "Ä".repeat(3000), artist: "Toshi" };
  assert.ok(buildEngagementHooks(long).every((hook) => isReadableHook(hook.text)));
  const plan = buildEngagementPlan({ subject: long, selection: { hook: "tease", captionStyle: "engagement" }, platform: "tiktok" })!;
  const length = plan.checklist.find((item) => item.id === "caption_length")!;
  assert.equal(length.status, "fail");
  assert.match(length.detail, /of 2200 characters/);
  const shorts = buildEngagementPlan({ subject: long, selection: { hook: "tease" }, platform: "youtube-shorts" })!;
  assert.equal(shorts.checklist.find((item) => item.id === "caption_length")!.status, "pass", "YouTube allows 5000");
});

test("hashtag collisions collapse case-insensitively and empty tags disappear", () => {
  const [hook] = buildEngagementHooks(SUBJECT);
  const typeBeat = buildEngagementCaption({ ...SUBJECT, artist: "Type Beat" }, hook, "instagram-reels", "engagement");
  assert.deepEqual(typeBeat.hashtags, ["TypeBeat", "Beats"]);
  const shortsArtist = buildEngagementCaption({ ...SUBJECT, artist: "shorts" }, hook, "youtube-shorts", "engagement");
  assert.deepEqual(shortsArtist.hashtags, ["Shorts", "TypeBeat", "Beats"]);
  const punctuationOnly = buildEngagementCaption({ ...SUBJECT, artist: "!!!", key: "—" }, hook, "tiktok", "discovery");
  assert.ok(punctuationOnly.hashtags.every((tag) => tag.length > 0));
  assert.deepEqual(punctuationOnly.hashtags, ["TypeBeat", "100BPM", "Producer"]);
  assert.ok(typeBeat.text.endsWith("#TypeBeat #Beats"));
});

/* ------------------------------------------------------------------ *
 * Platform tabs
 * ------------------------------------------------------------------ */

test("platform tabs follow the arrow/Home/End keyboard pattern and wrap", () => {
  assert.equal(nextTabIndex(0, "ArrowRight", 3), 1);
  assert.equal(nextTabIndex(2, "ArrowRight", 3), 0);
  assert.equal(nextTabIndex(0, "ArrowLeft", 3), 2);
  assert.equal(nextTabIndex(1, "ArrowDown", 3), 2);
  assert.equal(nextTabIndex(1, "ArrowUp", 3), 0);
  assert.equal(nextTabIndex(1, "Home", 3), 0);
  assert.equal(nextTabIndex(0, "End", 3), 2);
  assert.equal(nextTabIndex(1, "Enter", 3), null);
  assert.equal(nextTabIndex(1, "a", 3), null);
});
