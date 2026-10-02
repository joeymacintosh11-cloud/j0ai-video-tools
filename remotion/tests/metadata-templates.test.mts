import assert from "node:assert/strict";
import test from "node:test";
import {
  applyMetadataTemplatesResetPatch,
  BUILT_IN_DEFAULT_TEMPLATES,
  MAX_TEMPLATE_LENGTH,
  parseMetadataTemplates,
  parseMetadataTemplatesResetPatch,
  renderTemplate,
  resolveMetadataTemplates,
  scanTemplatePlaceholders,
  validateTemplateString,
  type PartialMetadataTemplates,
} from "../core/domain/content/metadataTemplates.ts";
import {
  buildPlatformMetadata,
  type PlatformMetadataSubject,
} from "../core/domain/content/platformMetadata.ts";

/**
 * The template renderer, the built-in defaults and the precedence chain
 * (track override -> global template -> built-in default). Pure — nothing
 * here touches the filesystem, so these run against hand-built inputs only.
 */

/* ------------------------------------------------------------------ *
 * The renderer: substitution, unknowns, escaping, normalization
 * ------------------------------------------------------------------ */

test("renders every known placeholder", () => {
  const result = renderTemplate("{title} by {artist} ({key}, {bpm} BPM) [{slug}/{platform}/{filename}]", {
    title: "Ghetto Geek",
    artist: "Toshi",
    key: "F Minor",
    bpm: "100",
    subtitle: "",
    slug: "ghetto-geek",
    platform: "YouTube",
    filename: "ghetto-geek-youtube.mp4",
    tagline: "",
    subtitleSuffix: "",
  });
  assert.equal(
    result.text,
    "Ghetto Geek by Toshi (F Minor, 100 BPM) [ghetto-geek/YouTube/ghetto-geek-youtube.mp4]",
  );
  assert.deepEqual(result.unknownPlaceholders, []);
});

test("multiple distinct placeholders in one template all resolve", () => {
  const result = renderTemplate("{title}-{artist}-{key}-{bpm}", {
    title: "T", artist: "A", key: "K", bpm: "1", subtitle: "", slug: "s",
    platform: "p", filename: "f", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "T-A-K-1");
});

test("a repeated placeholder is substituted every time it appears", () => {
  const result = renderTemplate("{title} {title} {title}", {
    title: "Echo", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "Echo Echo Echo");
});

test("an unknown placeholder is left literally in place and reported, never thrown", () => {
  const result = renderTemplate("{title} — {mood}", {
    title: "T", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "T — {mood}");
  assert.deepEqual(result.unknownPlaceholders, ["mood"]);
});

test("scanTemplatePlaceholders reports known and unknown separately", () => {
  const scan = scanTemplatePlaceholders("{title} {mood} {title} {vibe}");
  assert.deepEqual(scan.known, ["title"]);
  assert.deepEqual(scan.unknown, ["mood", "vibe"]);
});

test("{{literal}} braces are never treated as a placeholder", () => {
  const result = renderTemplate("{{title}} is literal, {title} is not", {
    title: "Real Title", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "{title} is literal, Real Title is not");
  assert.deepEqual(result.unknownPlaceholders, []);
});

test("literal braces around an unrecognized word never get reported as unknown", () => {
  const result = renderTemplate("50% off {{limited time}}", {
    title: "", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "50% off {limited time}");
  assert.deepEqual(result.unknownPlaceholders, []);
});

test("literal brace escapes do not rewrite identical-looking user values", () => {
  const sentinel = "\u0000TOSHI_LBRACE\u0000";
  const result = renderTemplate("{{title}} {title}", {
    title: sentinel, artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, `{title} ${sentinel}`);
});

test("empty optional placeholders render as empty string, not the literal token", () => {
  const result = renderTemplate("Subtitle: [{subtitle}]", {
    title: "", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "Subtitle: []");
});

test("blank-line runs left by an empty placeholder collapse to at most one blank line", () => {
  const result = renderTemplate("A\n\n{subtitle}\n\nB", {
    title: "", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "A\n\nB");
});

test("rendered output is trimmed", () => {
  const result = renderTemplate("  {title}  ", {
    title: "Trimmed", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "Trimmed");
});

/* ------------------------------------------------------------------ *
 * Unicode, emoji, quotes, accents, newlines, long titles
 * ------------------------------------------------------------------ */

test("Unicode, emoji, quotes and accents pass through untouched", () => {
  const result = renderTemplate('{title} — "quoted" 🎧 café', {
    title: "Ünïcödé Trâck", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, 'Ünïcödé Trâck — "quoted" 🎧 café');
});

test("a multiline description template renders every line", () => {
  const result = renderTemplate("Line one\nLine two\n{title}", {
    title: "Three", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "Line one\nLine two\nThree");
});

test("a very long title still renders in full — no truncation in the renderer itself", () => {
  const longTitle = "X".repeat(500);
  const result = renderTemplate("{title}", {
    title: longTitle, artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, longTitle);
});

/* ------------------------------------------------------------------ *
 * Security: plain substitution only
 * ------------------------------------------------------------------ */

test("no eval, no code execution: a value containing template syntax is inert text", () => {
  const result = renderTemplate("{title}", {
    title: "{{process.exit(1)}}", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  // The *value* substituted for {title} is copied verbatim — brace-escaping
  // only ever applies to the template's own text, before substitution, never
  // to a value being inserted. Nothing in this module calls eval/Function/
  // child_process/fs on a template or a value.
  assert.equal(result.text, "{{process.exit(1)}}");
});

test("a value with shell metacharacters is copied verbatim, never interpreted", () => {
  const result = renderTemplate("{title}", {
    title: "$(rm -rf /); `echo pwned`", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "$(rm -rf /); `echo pwned`");
});

test("an HTML-shaped value is copied as plain text, not executed or escaped here", () => {
  // This module has no notion of HTML at all — React's own escaping when the
  // UI renders this text as a child is what keeps it inert in the browser.
  const result = renderTemplate("{title}", {
    title: "<script>alert(1)</script>", artist: "", key: "", bpm: "", subtitle: "", slug: "",
    platform: "", filename: "", tagline: "", subtitleSuffix: "",
  });
  assert.equal(result.text, "<script>alert(1)</script>");
});

/* ------------------------------------------------------------------ *
 * Validation
 * ------------------------------------------------------------------ */

test("an unknown placeholder is rejected with a clear message naming it", () => {
  const { value, problems } = validateTemplateString("{title} is {vibe}", "youtube.titleTemplate");
  assert.equal(value, undefined);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /\{vibe\}/);
  assert.match(problems[0], /youtube\.titleTemplate/);
});

test("malformed single braces are rejected; doubled braces render literally", () => {
  for (const input of ["{ title }", "{title.foo}", "{{{title}}}", "{title\ntitle}", "{}", "{title", "title}", '{"name": 1}']) {
    assert.notEqual(validateTemplateString(input, "field").problems.length, 0, input);
  }
  for (const input of ["{unknown}", "{Title}", "{constructor}", "{__proto__}"]) {
    assert.notEqual(validateTemplateString(input, "field").problems.length, 0, input);
  }
  assert.deepEqual(validateTemplateString('{{"name": 1}} and {{title}}', "field").problems, []);
  assert.deepEqual(validateTemplateString('"{title}"', "field").problems, []);
  assert.equal(validateTemplateString("{{__proto__}}", "field").value, "{{__proto__}}");
});

test("empty strings are intentional at both precedence levels; whitespace is preserved until render trim", () => {
  const global = { youtube: { titleTemplate: "", descriptionTemplate: " " } };
  const track = { youtube: { titleTemplate: "" } };
  assert.equal(resolveMetadataTemplates(global, track).youtube.titleTemplate, "");
  assert.equal(resolveMetadataTemplates(global, null).youtube.titleTemplate, "");
  assert.equal(resolveMetadataTemplates(global, null).youtube.descriptionTemplate, " ");
  assert.equal(validateTemplateString("", "field").value, "");
  assert.equal(validateTemplateString(" ", "field").value, " ");
});

test("a non-string template value is rejected", () => {
  const { value, problems } = validateTemplateString(42, "field");
  assert.equal(value, undefined);
  assert.match(problems[0], /must be a string/);
});

test("an excessively long template is rejected as structurally invalid", () => {
  const { value, problems } = validateTemplateString("x".repeat(MAX_TEMPLATE_LENGTH + 1), "field");
  assert.equal(value, undefined);
  assert.match(problems[0], new RegExp(`${MAX_TEMPLATE_LENGTH}`));
});

test("a template at exactly the length limit is accepted", () => {
  const { value, problems } = validateTemplateString("x".repeat(MAX_TEMPLATE_LENGTH), "field");
  assert.equal(problems.length, 0);
  assert.equal(value?.length, MAX_TEMPLATE_LENGTH);
});

test("parseMetadataTemplates rejects an unknown platform key", () => {
  const { templates, problems } = parseMetadataTemplates({ tiktok: { captionTemplate: "{title}" } });
  assert.equal(templates, null);
  assert.match(problems[0], /tiktok/);
});

test("parseMetadataTemplates rejects an unknown field for a known platform", () => {
  const { templates, problems } = parseMetadataTemplates({ youtube: { thumbnailTemplate: "{title}" } });
  assert.equal(templates, null);
  assert.match(problems[0], /thumbnailTemplate/);
});

test("parseMetadataTemplates accepts a valid partial object and normalizes an empty one to null", () => {
  const valid = parseMetadataTemplates({ youtube: { titleTemplate: "{title}" } });
  assert.deepEqual(valid.templates, { youtube: { titleTemplate: "{title}" } });
  assert.deepEqual(valid.problems, []);

  const empty = parseMetadataTemplates({});
  assert.equal(empty.templates, null);
  assert.deepEqual(empty.problems, []);
});

test("parseMetadataTemplates rejects arrays and non-objects outright", () => {
  assert.notEqual(parseMetadataTemplates(["youtube"]).problems.length, 0);
  assert.notEqual(parseMetadataTemplates("youtube").problems.length, 0);
  assert.notEqual(parseMetadataTemplates(42).problems.length, 0);
});

/* ------------------------------------------------------------------ *
 * Precedence: track override -> global template -> built-in default
 * ------------------------------------------------------------------ */

test("with nothing configured, resolution is exactly the built-in defaults", () => {
  assert.deepEqual(resolveMetadataTemplates(null, null), BUILT_IN_DEFAULT_TEMPLATES);
  assert.deepEqual(resolveMetadataTemplates(undefined, undefined), BUILT_IN_DEFAULT_TEMPLATES);
});

test("a global override wins over the built-in default", () => {
  const resolved = resolveMetadataTemplates(
    { youtube: { titleTemplate: "{title} - {artist}" } },
    null,
  );
  assert.equal(resolved.youtube.titleTemplate, "{title} - {artist}");
  // Untouched fields still fall through to built-in.
  assert.equal(resolved.youtube.descriptionTemplate, BUILT_IN_DEFAULT_TEMPLATES.youtube.descriptionTemplate);
});

test("a track override wins over both the global template and the built-in default", () => {
  const resolved = resolveMetadataTemplates(
    { youtube: { titleTemplate: "{title} - {artist}" } }, // global
    { youtube: { titleTemplate: "{title} [Exclusive]" } }, // track
  );
  assert.equal(resolved.youtube.titleTemplate, "{title} [Exclusive]");
});

test("a partial track override only affects the field it names — everything else falls through per field", () => {
  const resolved = resolveMetadataTemplates(
    { youtube: { descriptionTemplate: "GLOBAL DESC" }, reels: { captionTemplate: "GLOBAL REELS" } },
    { youtube: { titleTemplate: "TRACK TITLE" } }, // only the title, nothing else
  );
  assert.equal(resolved.youtube.titleTemplate, "TRACK TITLE"); // track wins
  assert.equal(resolved.youtube.descriptionTemplate, "GLOBAL DESC"); // falls to global
  assert.equal(resolved.youtube.keywordsTemplate, BUILT_IN_DEFAULT_TEMPLATES.youtube.keywordsTemplate); // falls to built-in
  assert.equal(resolved.reels.captionTemplate, "GLOBAL REELS"); // untouched by the youtube-only override
  assert.equal(resolved.reels.hashtagsTemplate, BUILT_IN_DEFAULT_TEMPLATES.reels.hashtagsTemplate);
  assert.equal(resolved["instagram-square"].captionTemplate, BUILT_IN_DEFAULT_TEMPLATES["instagram-square"].captionTemplate);
});

test("clearing a track override (passing null/undefined) restores the global template", () => {
  const global: PartialMetadataTemplates = { youtube: { titleTemplate: "GLOBAL" } };
  const withOverride = resolveMetadataTemplates(global, { youtube: { titleTemplate: "TRACK" } });
  assert.equal(withOverride.youtube.titleTemplate, "TRACK");
  const cleared = resolveMetadataTemplates(global, null);
  assert.equal(cleared.youtube.titleTemplate, "GLOBAL");
});

test("resetting a global field (parseMetadataTemplatesResetPatch + apply) restores the built-in default", () => {
  const current: PartialMetadataTemplates = { youtube: { titleTemplate: "GLOBAL", descriptionTemplate: "GLOBAL DESC" } };
  const { patch } = parseMetadataTemplatesResetPatch({ youtube: { titleTemplate: null } });
  const next = applyMetadataTemplatesResetPatch(current, patch!);
  assert.equal(resolveMetadataTemplates(next, null).youtube.titleTemplate, BUILT_IN_DEFAULT_TEMPLATES.youtube.titleTemplate);
  // The field that was not reset stays.
  assert.equal(next.youtube?.descriptionTemplate, "GLOBAL DESC");
});

test("a reset patch accepts string (set), null (reset) and omitted (leave alone) per field", () => {
  const { patch, problems } = parseMetadataTemplatesResetPatch({
    youtube: { titleTemplate: "{title}", descriptionTemplate: null },
  });
  assert.deepEqual(problems, []);
  assert.deepEqual(patch, { youtube: { titleTemplate: "{title}", descriptionTemplate: null } });
});

test("an unknown placeholder in a reset patch is rejected, and nothing in that call is applied", () => {
  const { patch, problems } = parseMetadataTemplatesResetPatch({ youtube: { titleTemplate: "{mood}" } });
  assert.equal(patch, null);
  assert.notEqual(problems.length, 0);
});

/* ------------------------------------------------------------------ *
 * Backward compatibility: the built-in defaults reproduce the exact
 * hand-written output the previous implementation produced.
 * ------------------------------------------------------------------ */

const ghettoGeek: PlatformMetadataSubject = {
  title: "Ghetto Geek",
  artist: "Toshi",
  key: "F Minor",
  bpm: 100,
  subtitle: "Boom bap soul, trap bounce and latin heat.",
};

test("built-in YouTube metadata matches the product's existing default copy exactly", () => {
  const meta = buildPlatformMetadata("ghetto-geek", "youtube", ghettoGeek);
  assert.equal(meta.title, "Ghetto Geek | Boom bap soul, trap bounce and latin heat. | Toshi");
  assert.equal(
    meta.description,
    "Ghetto Geek by Toshi.\n\nKey: F Minor\nBPM: 100\n\nBoom bap soul, trap bounce and latin heat.\n\nProduced by Toshi.",
  );
  assert.deepEqual(meta.keywords, ["toshi", "100bpm", "f-minor", "type-beat"]);
});

test("built-in Reels/Instagram captions match the product's existing default copy exactly", () => {
  const reels = buildPlatformMetadata("ghetto-geek", "reels", ghettoGeek);
  assert.equal(reels.caption, "Ghetto Geek — Toshi (F Minor, 100 BPM) — Boom bap soul, trap bounce and latin heat.");
  const instagram = buildPlatformMetadata("ghetto-geek", "instagram-square", ghettoGeek);
  assert.equal(instagram.caption, reels.caption);
});

test("with no subtitle, the built-in title falls back to a key/BPM tagline, exactly as before", () => {
  const noSubtitle: PlatformMetadataSubject = { title: "Ghetto Geek", artist: "Toshi", key: "F Minor", bpm: 100 };
  const youtube = buildPlatformMetadata("ghetto-geek", "youtube", noSubtitle);
  assert.equal(youtube.title, "Ghetto Geek | F Minor · 100 BPM | Toshi");
  assert.equal(
    youtube.description,
    "Ghetto Geek by Toshi.\n\nKey: F Minor\nBPM: 100\n\nProduced by Toshi.",
  );
  const reels = buildPlatformMetadata("ghetto-geek", "reels", noSubtitle);
  assert.equal(reels.caption, "Ghetto Geek — Toshi (F Minor, 100 BPM)");
});

test("filenames are unaffected by templates — always the platform alias", () => {
  const meta = buildPlatformMetadata("ghetto-geek", "youtube", ghettoGeek, {
    ...BUILT_IN_DEFAULT_TEMPLATES,
    youtube: { ...BUILT_IN_DEFAULT_TEMPLATES.youtube, titleTemplate: "{filename}" },
  });
  assert.equal(meta.title, "ghetto-geek-youtube.mp4");
  assert.equal(meta.filename, "ghetto-geek-youtube.mp4");
});

/* ------------------------------------------------------------------ *
 * Hashtags/keywords are always derived from the rendered text, never
 * stored as a second, separate array form.
 * ------------------------------------------------------------------ */

test("hashtags are new, deterministic, and space-split from the rendered template", () => {
  const meta = buildPlatformMetadata("ghetto-geek", "reels", ghettoGeek);
  assert.deepEqual(meta.hashtags, ["#Toshi", "#TypeBeat", "#ToshiBeats"]);
});

test("a custom hashtags template with irregular whitespace still splits cleanly", () => {
  const meta = buildPlatformMetadata("ghetto-geek", "reels", ghettoGeek, {
    ...BUILT_IN_DEFAULT_TEMPLATES,
    reels: { ...BUILT_IN_DEFAULT_TEMPLATES.reels, hashtagsTemplate: "  #one   #two\n#three  " },
  });
  assert.deepEqual(meta.hashtags, ["#one", "#two", "#three"]);
});

test("keywords deduplicate case-insensitively after tagifying, keeping first occurrence order", () => {
  const meta = buildPlatformMetadata("x", "youtube", ghettoGeek, {
    ...BUILT_IN_DEFAULT_TEMPLATES,
    youtube: { ...BUILT_IN_DEFAULT_TEMPLATES.youtube, keywordsTemplate: "Toshi, TOSHI, toshi, Other Word" },
  });
  assert.deepEqual(meta.keywords, ["toshi", "other-word"]);
});
