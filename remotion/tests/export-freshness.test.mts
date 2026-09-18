import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import test, { type TestContext } from "node:test";
import { fixture } from "./fixtures.mts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { trackExportCoverage } from "../services/tracks/exportCoverage.ts";
import {
  fingerprintInputs,
  inputFingerprint,
  fileContentHash,
} from "../services/tracks/exportManifest.ts";
import { trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { publishExport } from "../services/render/publishExport.ts";
import { parseTrackMetadata } from "../src/domain/tracks/metadata.ts";
import {
  RENDER_PRESETS,
  type RenderPresetId,
} from "../src/domain/video/renderPresets.ts";
import {
  planMissingExports,
  toRenderTargets,
} from "../server/services/exportPlan.ts";

const setup = async (t: TestContext, extra = {}) => {
  const f = await fixture(t, extra);
  await writeFile(f.cover, "cover");
  await writeFile(f.beat, "audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));
  const props = buildTrackProps({
    slug: f.slug,
    metadata: parseTrackMetadata(
      JSON.parse(await readFile(f.metadata, "utf8")),
      "fixture",
    ),
    analysisAvailable: true,
  });
  const output = trackOutputLocation(f.slug, "youtube-16x9");
  const inputs = fingerprintInputs(props, "youtube-16x9");
  const publish = (presetId: RenderPresetId = "youtube-16x9") =>
    publishExport(
      f.slug,
      presetId,
      fingerprintInputs(props, presetId),
      async (file) => {
        await writeFile(file, "successful video");
      },
    );
  const state = () => trackExportCoverage(f.slug)[0];
  return { ...f, props, output, inputs, publish, state };
};

test("successful publication writes a valid manifest and reports current", async (t) => {
  const f = await setup(t);
  await f.publish();
  const manifest = JSON.parse(await readFile(f.output.manifest, "utf8"));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.inputFingerprint, inputFingerprint(f.inputs));
  assert.equal(f.state().freshness, "current");
  assert.deepEqual(await readdir(f.output.dir), [
    "youtube-16x9.manifest.json",
    "youtube-16x9.mp4",
  ]);
});

for (const field of ["title", "artist", "key", "bpm", "subtitle"]) {
  test(`${field} change makes export stale`, async (t) => {
    const f = await setup(t);
    await f.publish();
    const metadata = JSON.parse(await readFile(f.metadata, "utf8"));
    metadata[field] = field === "bpm" ? 123 : "Changed";
    await writeFile(f.metadata, JSON.stringify(metadata));
    assert.deepEqual(f.state().staleReasons, ["metadata_changed"]);
  });
}
for (const [asset, reason] of [
  ["cover", "cover_changed"],
  ["beat", "audio_changed"],
] as const) {
  test(`${asset} content change invalidates cached identity`, async (t) => {
    const f = await setup(t);
    await f.publish();
    assert.equal(f.state().freshness, "current");
    await writeFile(f[asset], "changed bytes");
    assert.deepEqual(f.state().staleReasons, [reason]);
  });
}
for (const kind of ["analysis", "unrelated", "intent"]) {
  test(`${kind} changes do not stale the output`, async (t) => {
    const f = await setup(t);
    await f.publish();
    if (kind === "intent") {
      const data = JSON.parse(await readFile(f.metadata, "utf8"));
      await writeFile(
        f.metadata,
        JSON.stringify({ ...data, exportPresets: ["square-1x1"] }),
      );
    } else
      await writeFile(
        kind === "analysis" ? f.analysis : `${f.trackDir}/notes.txt`,
        "changed",
      );
    assert.equal(f.state().freshness, "current");
  });
}

test("preset render settings changed independently of labels", async (t) => {
  const f = await setup(t);
  await f.publish();
  const before = RENDER_PRESETS["youtube-16x9"];
  try {
    RENDER_PRESETS["youtube-16x9"] = { ...before, label: "New UI label" };
    assert.equal(f.state().freshness, "current");
    RENDER_PRESETS["youtube-16x9"] = { ...before, width: 1280 };
    assert.deepEqual(f.state().staleReasons, ["preset_changed"]);
  } finally {
    RENDER_PRESETS["youtube-16x9"] = before;
  }
});

test("old visualizer version hash makes export stale", async (t) => {
  const f = await setup(t);
  await publishExport(
    f.slug,
    "youtube-16x9",
    { ...f.inputs, visualizer: "a".repeat(64) },
    async (file) => {
      await writeFile(file, "old version");
    },
  );
  assert.deepEqual(f.state().staleReasons, ["visualizer_changed"]);
});

for (const variant of [
  "missing",
  "empty",
  "legacy",
  "corrupt",
  "wrong-preset",
  "incompatible",
  "changed-output",
]) {
  test(`coverage handles ${variant} output safely`, async (t) => {
    const f = await setup(t);
    await f.publish();
    if (variant === "missing") await rm(f.output.path);
    if (variant === "empty") await writeFile(f.output.path, "");
    if (variant === "legacy") await rm(f.output.manifest);
    if (variant === "corrupt") await writeFile(f.output.manifest, "not json");
    if (variant === "wrong-preset" || variant === "incompatible") {
      const data = JSON.parse(await readFile(f.output.manifest, "utf8"));
      if (variant === "wrong-preset") data.presetId = "square-1x1";
      else data.schemaVersion = 99;
      await writeFile(f.output.manifest, JSON.stringify(data));
    }
    if (variant === "changed-output")
      await writeFile(f.output.path, "replacement video");
    const state = f.state();
    assert.equal(
      state.freshness,
      variant === "missing" || variant === "empty" ? "missing" : "stale",
    );
    if (variant === "legacy")
      assert.deepEqual(state.staleReasons, ["manifest_missing"]);
    if (["corrupt", "wrong-preset", "incompatible"].includes(variant))
      assert.deepEqual(state.staleReasons, ["manifest_invalid"]);
    if (variant === "changed-output")
      assert.deepEqual(state.staleReasons, ["output_changed"]);
  });
}

for (const previous of [false, true]) {
  for (const outcome of ["failed", "cancelled", "empty"] as const) {
    test(`${outcome} render preserves ${previous ? "previous pair" : "absence of output"}`, async (t) => {
      const f = await setup(t);
      if (previous) await f.publish();
      const before = previous
        ? await readFile(f.output.manifest, "utf8")
        : null;
      let cancelled = false;
      await assert.rejects(() =>
        publishExport(
          f.slug,
          "youtube-16x9",
          f.inputs,
          async (file) => {
            await writeFile(file, outcome === "empty" ? "" : "partial");
            if (outcome === "failed") throw new Error("render failed");
            if (outcome === "cancelled") cancelled = true;
          },
          () => {
            if (cancelled) throw new Error("cancelled");
          },
        ),
      );
      if (previous) {
        assert.equal(await readFile(f.output.manifest, "utf8"), before);
        assert.equal(await readFile(f.output.path, "utf8"), "successful video");
        assert.equal(f.state().freshness, "current");
      } else assert.equal(f.state().rendered, false);
      assert.equal(
        (await readdir(f.output.dir)).some((name) =>
          name.startsWith(".render-"),
        ),
        false,
      );
    });
  }
}

test("manifest publication failure rolls back previous video and manifest", async (t) => {
  const f = await setup(t);
  await f.publish();
  const previous = await readFile(f.output.manifest, "utf8");
  const rename = fs.renameSync;
  t.mock.method(fs, "renameSync", (from: fs.PathLike, to: fs.PathLike) => {
    if (to === f.output.manifest) throw new Error("disk error");
    return rename(from, to);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  await assert.rejects(
    () =>
      publishExport(f.slug, "youtube-16x9", f.inputs, async (file) => {
        await writeFile(file, "new video");
      }),
    /disk error/,
  );
  assert.equal(await readFile(f.output.path, "utf8"), "successful video");
  assert.equal(await readFile(f.output.manifest, "utf8"), previous);
  assert.equal(f.state().freshness, "current");
});

test("source changes during render report stale, never certify the edited inputs", async (t) => {
  const f = await setup(t);
  await publishExport(f.slug, "youtube-16x9", f.inputs, async (file) => {
    await writeFile(f.cover, "new artwork while rendering");
    await writeFile(file, "video of old artwork");
  });
  assert.deepEqual(f.state().staleReasons, ["cover_changed"]);
});

test("warm file fingerprint checks stat but do not read full audio again", async (t) => {
  const f = await setup(t);
  const first = fileContentHash(f.beat);
  t.mock.method(fs, "readSync", () => {
    throw new Error("unnecessary file read");
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  assert.equal(fileContentHash(f.beat), first);
});

for (const mode of ["missing", "stale", "missing-and-stale"] as const) {
  test(`${mode} planner selects only matching states, respecting track intent`, async (t) => {
    const a = await setup(t); // current, stale, missing
    const b = await setup(t, { exportPresets: ["square-1x1"] });
    await a.publish();
    const vertical = trackOutputLocation(a.slug, "vertical-9x16");
    await mkdir(vertical.dir, { recursive: true });
    await writeFile(vertical.path, "legacy video");
    const plan = await planMissingExports({ slugs: [a.slug, b.slug], mode });
    assert.equal(plan.current.length, 1);
    assert.equal(plan.stale.length, 1);
    assert.equal(plan.missing.length, 2);
    const expected =
      mode === "missing"
        ? ["square-1x1", "square-1x1"]
        : mode === "stale"
          ? ["vertical-9x16"]
          : ["vertical-9x16", "square-1x1", "square-1x1"];
    assert.deepEqual(
      plan.selected.map((entry) => entry.presetId),
      expected,
    );
    assert.equal(toRenderTargets(plan).length, expected.length);
    assert.deepEqual(plan.stale[0].staleReasons, ["manifest_missing"]);
  });
}

test("stale planning skips queued and active replacements before considering disk", async (t) => {
  const f = await setup(t);
  await f.publish();
  await f.publish("vertical-9x16");
  await writeFile(f.beat, "changed");
  const plan = await planMissingExports({
    slugs: [f.slug],
    mode: "missing-and-stale",
    inFlight: new Map([
      [`${f.slug}::youtube-16x9`, "active"],
      [`${f.slug}::vertical-9x16`, "queued"],
    ]),
  });
  assert.equal(plan.skippedActive.length, 1);
  assert.equal(plan.skippedQueued.length, 1);
  assert.deepEqual(
    plan.selected.map((entry) => entry.presetId),
    ["square-1x1"],
  );
});

test("catalogue plans mixed freshness with each track's own intent and rejects invalid tracks", async (t) => {
  const a = await setup(t, { exportPresets: ["youtube-16x9", "square-1x1"] });
  const b = await setup(t, { exportPresets: ["vertical-9x16"] });
  const invalid = await setup(t);
  await a.publish();
  await b.publish("vertical-9x16");
  await writeFile(b.cover, "changed");
  await writeFile(invalid.metadata, "invalid");
  const plan = await planMissingExports({ mode: "missing-and-stale" });
  const own = plan.selected.filter((entry) =>
    [a.slug, b.slug, invalid.slug].includes(entry.slug),
  );
  assert.deepEqual(
    own.map((entry) => `${entry.slug}/${entry.presetId}`).sort(),
    [`${a.slug}/square-1x1`, `${b.slug}/vertical-9x16`].sort(),
  );
  assert.ok(plan.invalid.some((entry) => entry.slug === invalid.slug));
});

test("successful replacement refreshes stale manifest and preserves output naming", async (t) => {
  const f = await setup(t);
  await f.publish();
  await writeFile(f.beat, "updated audio");
  assert.equal(f.state().freshness, "stale");
  await f.publish();
  assert.equal(f.state().freshness, "current");
  assert.equal(f.state().outputLabel, `out/${f.slug}/youtube-16x9.mp4`);
});

test("CLI mode planning is shared and replacements require explicit confirmation", async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const f = await setup(t, { exportPresets: ["youtube-16x9"] });
  await f.publish();
  await writeFile(f.cover, "changed artwork");
  const run = promisify(execFile);
  const before = await readFile(f.output.manifest, "utf8");
  const dry = await run(process.execPath, [
    "scripts/render-missing.mts",
    f.slug,
    "--mode",
    "stale",
    "--dry-run",
  ]);
  assert.match(dry.stdout, /1 stale/);
  assert.match(dry.stdout, /replace stale export/);
  await assert.rejects(
    () =>
      run(process.execPath, [
        "scripts/render-missing.mts",
        f.slug,
        "--mode",
        "stale",
      ]),
    (error: unknown) => {
      assert.match((error as { stderr: string }).stderr, /--replace/);
      return true;
    },
  );
  assert.equal(await readFile(f.output.manifest, "utf8"), before);
  const missing = await run(process.execPath, [
    "scripts/render-missing.mts",
    f.slug,
    "--dry-run",
  ]);
  assert.match(missing.stdout, /0 missing/);
});
