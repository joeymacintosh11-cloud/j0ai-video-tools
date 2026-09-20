import assert from "node:assert/strict";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import {
  CONTENT_METADATA_SETTINGS_FILE,
  readContentMetadataSettings,
  writeContentMetadataSettingsPatch,
} from "../services/content/metadataTemplateSettings.ts";
import { TrackError } from "../src/domain/tracks/errors.ts";

/**
 * The global content-metadata settings file, tested entirely against a
 * mocked `fsPromises.readFile` — exactly the pattern
 * destination-fix-plan-render.test.mts already uses for delivery.local.json
 * — so nothing here ever reads or writes this project's own real
 * content-metadata.local.json. Writes are exercised through the pure
 * `applyMetadataTemplatesResetPatch`/`parseMetadataTemplatesResetPatch`
 * functions (tests/metadata-templates.test.mts) and were also verified
 * end-to-end via the CLI against a real file during manual verification
 * (see the handoff doc) — this file focuses on the read/malformed-file
 * behavior that specifically needs real fs semantics to be meaningful.
 */

const mockRead = (
  t: import("node:test").TestContext,
  content: string | { readonly code: string },
) => {
  const real = fsPromises.readFile.bind(fsPromises);
  t.mock.method(fsPromises, "readFile", (async (...args: Parameters<typeof fsPromises.readFile>) => {
    if (String(args[0]) === CONTENT_METADATA_SETTINGS_FILE) {
      if (typeof content === "string") return content;
      const error = new Error(`mock ${content.code}`) as NodeJS.ErrnoException;
      error.code = content.code;
      throw error;
    }
    return real(...args);
  }) as typeof fsPromises.readFile);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
};

test("a missing settings file means nothing configured — not corruption", async (t) => {
  mockRead(t, { code: "ENOENT" });
  const { settings, problem } = await readContentMetadataSettings();
  assert.deepEqual(settings.templates, {});
  assert.equal(problem, null);
});

test("malformed JSON is reported as a problem, and built-in defaults are used, not a crash", async (t) => {
  mockRead(t, "{ not json");
  const { settings, problem } = await readContentMetadataSettings();
  assert.deepEqual(settings.templates, {});
  assert.notEqual(problem, null);
  assert.match(problem!, /not valid JSON/);
});

test("a settings file with an unknown placeholder is reported as malformed, not silently accepted", async (t) => {
  mockRead(t, JSON.stringify({ schemaVersion: 1, templates: { youtube: { titleTemplate: "{mood}" } } }));
  const { settings, problem } = await readContentMetadataSettings();
  assert.deepEqual(settings.templates, {});
  assert.notEqual(problem, null);
  assert.match(problem!, /mood/);
});

test("a settings file with an unreadable-for-other-reasons error is surfaced, not swallowed", async (t) => {
  mockRead(t, { code: "EACCES" });
  const { settings, problem } = await readContentMetadataSettings();
  assert.deepEqual(settings.templates, {});
  assert.notEqual(problem, null);
  assert.match(problem!, /could not be read/);
});

test("a valid settings file round-trips through parsing untouched", async (t) => {
  mockRead(t, JSON.stringify({
    schemaVersion: 1,
    templates: { youtube: { titleTemplate: "{title} — {artist}" } },
  }));
  const { settings, problem } = await readContentMetadataSettings();
  assert.equal(problem, null);
  assert.deepEqual(settings.templates, { youtube: { titleTemplate: "{title} — {artist}" } });
});

test("writing on top of a currently-unreadable settings file is refused, not silently overwritten", async (t) => {
  mockRead(t, "{ not json");
  await assert.rejects(
    () => writeContentMetadataSettingsPatch({ youtube: { titleTemplate: "{title}" } }),
    (error: unknown) => {
      assert.ok(error instanceof TrackError);
      assert.equal(error.code, "TEMPLATE_INVALID");
      return true;
    },
  );
});

test("an invalid patch is rejected before any read/write of the current settings happens", async (t) => {
  mockRead(t, { code: "ENOENT" });
  await assert.rejects(
    () => writeContentMetadataSettingsPatch({ youtube: { titleTemplate: "{mood}" } }),
    (error: unknown) => {
      assert.ok(error instanceof TrackError);
      assert.equal(error.code, "TEMPLATE_INVALID");
      return true;
    },
  );
});
