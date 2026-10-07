import assert from "node:assert/strict";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  draftPostText,
  parsePublicationDraftFields,
  publicationDraftProblems,
  statusAllowed,
  type PublicationDraftFields,
} from "../core/domain/publishing/publicationDraft.ts";
import type { TrackSummaryView } from "../core/domain/api/views.ts";
import { handleRequest } from "../server/app.ts";
import {
  createPublicationDraft,
  getPublicationDraft,
  listPublicationDrafts,
  updatePublicationDraft,
} from "../services/publishing/publicationDrafts.ts";
import { trackLocations } from "../services/tracks/trackLocations.ts";
import {
  draftFields,
  exportedAssets,
  newDraftForm,
  parseHashtagInput,
  platformsForFormat,
} from "../ui/components/publishingDashboardModel.ts";
import { isolatePublishing, publishingTrack } from "./publishingHarness.mts";

/**
 * Publication drafts: the pure rules, the file-backed service (isolated
 * publishing root, synthetic but genuinely published exports), the HTTP API
 * and the dashboard's pure model. Nothing here uploads; no real track,
 * export or publishing state is touched.
 */

const fields = (slug: string, overrides: Partial<PublicationDraftFields> = {}): PublicationDraftFields => ({
  platform: "youtube",
  source: { track: slug, format: "youtube-16x9", renderer: "remotion" },
  title: "Fixture — Toshi",
  description: "A synthetic beat.",
  hashtags: ["lofi", "beats"],
  status: "draft",
  ...overrides,
});

const CURRENT = { trackValid: true, freshness: "current" } as const;

const rejectsWith = (code: string, pattern?: RegExp) => (error: unknown) => {
  assert.equal((error as { issue?: { code: string } }).issue?.code ?? (error as { code?: string }).code, code);
  if (pattern) assert.match((error as Error).message, pattern);
  return true;
};

/* ------------------------------------------------------------------ *
 * Pure rules
 * ------------------------------------------------------------------ */

test("draft fields are normalised: bare de-duplicated hashtags, trimmed text, draft status by default", () => {
  const parsed = parsePublicationDraftFields({
    platform: "instagram",
    source: { track: "probe", format: "square-1x1", renderer: "after-effects" },
    title: "  Probe  ",
    hashtags: ["#LoFi", "lofi", "##beats", " "],
  });
  assert.deepEqual(parsed.problems, []);
  assert.deepEqual(parsed.fields, {
    platform: "instagram",
    source: { track: "probe", format: "square-1x1", renderer: "after-effects" },
    title: "Probe",
    description: "",
    hashtags: ["LoFi", "beats"],
    status: "draft",
  });
});

test("malformed drafts are refused field by field: platform, source, status, multi-word hashtags", () => {
  const parsed = parsePublicationDraftFields({
    platform: "myspace",
    source: { track: "", format: "8k", renderer: "premiere-2031" },
    status: "scheduled",
    hashtags: ["lo fi"],
  });
  assert.equal(parsed.fields, null);
  const fieldsWithProblems = new Set(parsed.problems.map((problem) => problem.field));
  for (const field of ["platform", "source", "status", "hashtags"]) assert.ok(fieldsWithProblems.has(field), field);
  assert.equal(parsePublicationDraftFields(null).fields, null);
});

test("readiness needs a format the platform takes, a current export, and text within the platform's limits", () => {
  assert.deepEqual(publicationDraftProblems(fields("probe"), CURRENT), []);

  const reasons = (draft: PublicationDraftFields, facts: Parameters<typeof publicationDraftProblems>[1] = CURRENT) =>
    publicationDraftProblems(draft, facts).map((problem) => problem.reason);
  assert.deepEqual(reasons(fields("probe", { platform: "tiktok" })), ["format_unsupported"]);
  assert.deepEqual(reasons(fields("probe"), { trackValid: true, freshness: "stale" }), ["export_stale"]);
  assert.deepEqual(reasons(fields("probe"), { trackValid: true, freshness: "missing" }), ["export_missing"]);
  assert.deepEqual(reasons(fields("probe"), { trackValid: false, freshness: "invalid" }), ["track_invalid"]);
  assert.deepEqual(reasons(fields("probe", { title: "" })), ["publication_metadata_invalid"]);
  assert.deepEqual(reasons(fields("probe", { title: "x".repeat(101) })), ["publication_metadata_invalid"]);
  const hyphen = publicationDraftProblems(fields("probe", { hashtags: ["a-minor", "über_beats", "102bpm"] }), CURRENT);
  assert.deepEqual(hyphen.map((problem) => problem.message), ["#a-minor would post as #a: hashtags take letters, digits and underscores only."]);

  const tooManyTags = fields("probe", {
    platform: "instagram",
    source: { track: "probe", format: "vertical-9x16", renderer: "remotion" },
    hashtags: Array.from({ length: 31 }, (_, i) => `tag${i}`),
  });
  const problems = publicationDraftProblems(tooManyTags, CURRENT);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].field, "hashtags");

  assert.equal(statusAllowed("draft", problems), true);
  assert.equal(statusAllowed("ready", problems), false);
  assert.equal(statusAllowed("posted", problems), false);
  assert.equal(statusAllowed("ready", []), true);
  assert.equal(draftPostText({ description: "New beat.", hashtags: ["lofi", "beats"] }), "New beat.\n\n#lofi #beats");
  assert.equal(draftPostText({ description: "", hashtags: [] }), "");
});

/* ------------------------------------------------------------------ *
 * Service
 * ------------------------------------------------------------------ */

test("a draft is saved, listed and reloaded; ready is accepted only while its export is current", async (t) => {
  const iso = await isolatePublishing(t);
  const f = await publishingTrack(t);
  const output = await f.render("remotion", "youtube-16x9");
  const exportBytes = await readFile(output.path);

  const created = await createPublicationDraft(fields(f.slug, { status: "ready" }));
  assert.equal(created.draft.revision, 1);
  assert.match(created.draft.draftId, /^drf_[a-f0-9]{24}$/);
  assert.equal(created.export.freshness, "current");
  assert.deepEqual(created.problems, []);
  assert.ok(existsSync(path.join(iso.root!, "drafts", `${created.draft.draftId}.json`)));

  const listed = await listPublicationDrafts();
  assert.deepEqual(listed.drafts.map((view) => view.draft.draftId), [created.draft.draftId]);
  assert.deepEqual((await listPublicationDrafts({ track: "some-other-track" })).drafts, []);
  assert.deepEqual((await getPublicationDraft(created.draft.draftId)).draft, created.draft);

  // The track changes after rendering: the export goes stale, and the draft says so.
  const metadataFile = trackLocations(f.slug).metadata;
  const raw = JSON.parse(await readFile(metadataFile, "utf8"));
  await writeFile(metadataFile, JSON.stringify({ ...raw, title: `${raw.title} (edited)` }, null, 2));
  const stale = await getPublicationDraft(created.draft.draftId);
  assert.equal(stale.export.freshness, "stale");
  assert.deepEqual(stale.problems.map((problem) => problem.reason), ["export_stale"]);

  await assert.rejects(
    updatePublicationDraft(created.draft.draftId, { ...fields(f.slug, { status: "posted" }), revision: 1 }),
    rejectsWith("PUBLISH_DRAFT_INVALID", /stale/),
  );
  const backToDraft = await updatePublicationDraft(created.draft.draftId, { ...fields(f.slug, { title: "Edited" }), revision: 1 });
  assert.equal(backToDraft.draft.revision, 2);
  assert.equal(backToDraft.draft.status, "draft");
  assert.equal(backToDraft.draft.title, "Edited");
  assert.equal(backToDraft.draft.createdAt, created.draft.createdAt);

  // Planning data only: the export is untouched and no publish job exists.
  assert.deepEqual(await readFile(output.path), exportBytes);
  assert.equal(existsSync(path.join(iso.root!, "jobs")), false);
  assert.equal(existsSync(path.join(iso.root!, "receipts.jsonl")), false);
});

test("an After Effects draft is judged against the After Effects export, never the Remotion one", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion", "vertical-9x16");

  const ae = fields(f.slug, {
    platform: "tiktok",
    source: { track: f.slug, format: "vertical-9x16", renderer: "after-effects" },
  });
  const created = await createPublicationDraft(ae);
  assert.equal(created.export.freshness, "missing");
  assert.deepEqual(created.problems.map((problem) => problem.reason), ["export_missing"]);
  await assert.rejects(createPublicationDraft({ ...ae, status: "ready" }), rejectsWith("PUBLISH_DRAFT_INVALID"));

  const remotion = await createPublicationDraft({ ...ae, source: { ...ae.source, renderer: "remotion" }, status: "ready" });
  assert.deepEqual(remotion.problems, []);
});

test("an edit from an older revision is a conflict and changes nothing", async (t) => {
  const iso = await isolatePublishing(t);
  const f = await publishingTrack(t);
  const created = await createPublicationDraft(fields(f.slug));
  const file = path.join(iso.root!, "drafts", `${created.draft.draftId}.json`);
  await updatePublicationDraft(created.draft.draftId, { ...fields(f.slug, { title: "First edit" }), revision: 1 });
  const before = await readFile(file, "utf8");

  await assert.rejects(
    updatePublicationDraft(created.draft.draftId, { ...fields(f.slug, { title: "Lost edit" }), revision: 1 }),
    rejectsWith("PUBLISH_DRAFT_CONFLICT", /revision 2/),
  );
  await assert.rejects(updatePublicationDraft(created.draft.draftId, fields(f.slug)), rejectsWith("INVALID_REQUEST"));
  assert.equal(await readFile(file, "utf8"), before);
});

test("unknown tracks and ids are refused; an unreadable draft file is reported and left untouched", async (t) => {
  const iso = await isolatePublishing(t);
  const f = await publishingTrack(t);
  await assert.rejects(createPublicationDraft(fields("no-such-track-anywhere")), rejectsWith("TRACK_NOT_FOUND"));
  await assert.rejects(createPublicationDraft(fields("../escape")), rejectsWith("TRACK_NOT_FOUND"));
  await assert.rejects(getPublicationDraft("../../etc/passwd"), rejectsWith("PUBLISH_DRAFT_NOT_FOUND"));
  await assert.rejects(getPublicationDraft(`drf_${"0".repeat(24)}`), rejectsWith("PUBLISH_DRAFT_NOT_FOUND"));

  const good = await createPublicationDraft(fields(f.slug));
  const damaged = path.join(iso.root!, "drafts", `drf_${"a".repeat(24)}.json`);
  await mkdir(path.dirname(damaged), { recursive: true });
  await writeFile(damaged, "{ not json");
  const listed = await listPublicationDrafts();
  assert.deepEqual(listed.drafts.map((view) => view.draft.draftId), [good.draft.draftId]);
  assert.equal(listed.problems.length, 1);
  assert.equal(await readFile(damaged, "utf8"), "{ not json");
  assert.deepEqual((await readdir(path.join(iso.root!, "drafts"))).sort(), [`${good.draft.draftId}.json`, path.basename(damaged)].sort());
});

/* ------------------------------------------------------------------ *
 * HTTP
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
  return async (method: string, url: string, body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${url}`, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { status: response.status, json: (await response.json()) as { data: any; error: { code: string } } };
  };
};

test("API: create, list, edit with a revision, and explicit 400/404/409 answers", async (t) => {
  await isolatePublishing(t);
  const f = await publishingTrack(t);
  await f.render("remotion", "youtube-16x9");
  const call = await api(t);

  const created = await call("POST", "/api/publish/drafts", fields(f.slug));
  assert.equal(created.status, 200);
  const id = created.json.data.draft.draftId;

  const listed = await call("GET", `/api/publish/drafts?track=${f.slug}`);
  assert.equal(listed.json.data.drafts.length, 1);
  assert.equal((await call("GET", `/api/publish/drafts/${id}`)).json.data.draft.title, "Fixture — Toshi");

  const edited = await call("PATCH", `/api/publish/drafts/${id}`, { ...fields(f.slug, { status: "ready" }), revision: 1 });
  assert.equal(edited.status, 200);
  assert.equal(edited.json.data.draft.status, "ready");

  const conflict = await call("PATCH", `/api/publish/drafts/${id}`, { ...fields(f.slug), revision: 1 });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.json.error.code, "PUBLISH_DRAFT_CONFLICT");

  const invalid = await call("POST", "/api/publish/drafts", { ...fields(f.slug), platform: "myspace" });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.error.code, "PUBLISH_DRAFT_INVALID");

  const notReady = await call("POST", "/api/publish/drafts", fields(f.slug, { platform: "tiktok", status: "ready" }));
  assert.equal(notReady.status, 400);

  assert.equal((await call("GET", `/api/publish/drafts/drf_${"f".repeat(24)}`)).status, 404);
  assert.equal((await call("GET", "/api/publish/drafts?track=..%2Fescape")).status, 400);
});

/* ------------------------------------------------------------------ *
 * Dashboard model
 * ------------------------------------------------------------------ */

test("dashboard model: rendered exports become assets; forms seed and parse hashtags as single words", () => {
  const track = {
    slug: "probe",
    title: "Probe",
    exportsRenderer: "after-effects",
    exports: [
      { presetId: "youtube-16x9", label: "YouTube 16:9", present: true, freshness: "current" },
      { presetId: "vertical-9x16", label: "Reels 9:16", present: false, freshness: "missing" },
      { presetId: "square-1x1", label: "Square 1:1", present: true, freshness: "stale" },
    ],
  } as unknown as TrackSummaryView;
  assert.deepEqual(exportedAssets([track]), [
    { slug: "probe", title: "Probe", format: "youtube-16x9", label: "YouTube 16:9", renderer: "after-effects", freshness: "current" },
    { slug: "probe", title: "Probe", format: "square-1x1", label: "Square 1:1", renderer: "after-effects", freshness: "stale" },
  ]);

  assert.deepEqual(platformsForFormat("youtube-16x9"), ["youtube"]);
  assert.deepEqual(platformsForFormat("vertical-9x16"), ["youtube", "instagram", "tiktok"]);
  assert.deepEqual(platformsForFormat("square-1x1"), ["instagram"]);

  const form = newDraftForm(
    { slug: "probe", format: "square-1x1", renderer: "after-effects" },
    {
      slug: "probe",
      title: "Probe",
      platforms: [
        {
          platformId: "instagram-square",
          title: null,
          description: null,
          caption: "New beat out now\nlink in bio",
          keywords: ["lo fi beats", "a-minor"],
          hashtags: ["#toshi"],
        },
      ],
    } as never,
  );
  assert.equal(form.platform, "instagram");
  assert.equal(form.renderer, "after-effects");
  assert.equal(form.title, "New beat out now");
  assert.equal(form.hashtags, "#lofibeats #aminor #toshi");
  assert.equal(form.status, "draft");

  assert.deepEqual(parseHashtagInput("#lofi #beats, chill\n#lofi"), ["lofi", "beats", "chill", "lofi"]);
  assert.deepEqual(draftFields({ ...form, hashtags: "#a #b" }).hashtags, ["a", "b"]);
  assert.deepEqual(newDraftForm({ slug: "probe", format: "youtube-16x9", renderer: "remotion" }, null).title, "");
});
