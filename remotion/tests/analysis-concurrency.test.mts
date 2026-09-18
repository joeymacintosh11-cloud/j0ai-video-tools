import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { promisify } from "node:util";
import { ensureAnalysisAudio } from "../services/tracks/prepareTrackAudio.ts";
import { trackLocations } from "../services/tracks/trackLocations.ts";
import { fixture } from "./fixtures.mts";

/**
 * Concurrent preparation of the shared analysis audio.
 *
 * Two renders of *different* formats of one track are two separate processes
 * doing the same derived conversion at the same time. The render target lock
 * does not cover it — deliberately, since those are different targets and
 * serializing them would defeat the point — so the safety has to come from how
 * the file is published.
 *
 * ffmpeg is required, as it is for the normal prepare step.
 */

const execFileAsync = promisify(execFile);

const sha256 = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");

/** A track with real, decodable audio; ffmpeg has to be able to convert it. */
const audibleTrack = async (t: TestContext, seconds = 1) => {
  const f = await fixture(t);
  await execFileAsync("ffmpeg", [
    "-v", "error", "-f", "lavfi",
    "-i", `sine=frequency=220:duration=${seconds}`,
    "-ac", "2", "-ar", "44100", "-c:a", "pcm_s24le",
    "-y", f.beat,
  ]);
  t.after(() => rm(f.analysis, { force: true }));
  return f;
};

const leftovers = async (slug: string): Promise<string[]> =>
  (await readdir(trackLocations(slug).trackDir)).filter((name) =>
    name.includes(".tmp-"),
  );

test("competing processes converge on one complete analysis file", async (t) => {
  const f = await audibleTrack(t);

  // A reference conversion, then remove it so every competitor starts from
  // nothing and they all race the same contended path.
  await ensureAnalysisAudio(f.slug);
  const reference = sha256(await readFile(f.analysis));
  await rm(f.analysis, { force: true });

  const children = await Promise.all(
    Array.from({ length: 4 }, async () => {
      const child = fork(new URL("./analysis-process.mts", import.meta.url), [f.slug], {
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      t.after(() => {
        if (child.exitCode === null) child.kill("SIGKILL");
      });
      await once(child, "message");
      return child;
    }),
  );

  const replies = children.map((child) => once(child, "message"));
  children.forEach((child) => child.send("prepare"));
  const results = await Promise.all(replies);

  assert.deepEqual(
    results.map(([reply]) => reply.type),
    ["prepared", "prepared", "prepared", "prepared"],
    "every competitor succeeds; none corrupts another's work",
  );

  // Deterministic: the same input always produces the same bytes, so whichever
  // conversion published last is indistinguishable from any other.
  assert.equal(
    sha256(await readFile(f.analysis)),
    reference,
    "the published file is a complete, correct conversion",
  );

  // A truncated or partially written result would not carry a full RIFF header.
  const published = await readFile(f.analysis);
  assert.equal(published.subarray(0, 4).toString("latin1"), "RIFF");
  assert.equal(published.subarray(8, 12).toString("latin1"), "WAVE");
  assert.ok((await stat(f.analysis)).size > 0);

  assert.deepEqual(await leftovers(f.slug), [], "no staging files remain");
});

test("a reader only ever sees a complete file, never a partial one", async (t) => {
  const f = await audibleTrack(t, 2);

  await ensureAnalysisAudio(f.slug);
  const first = sha256(await readFile(f.analysis));

  // Rewriting the source makes it newer than the analysis, so preparation runs
  // again. Publication is a rename of an already-finished file, so every sample
  // taken during that conversion must be one of the two complete versions.
  await writeFile(f.beat, await readFile(f.beat));

  const samples: string[] = [];
  const sampling = setInterval(() => {
    try {
      samples.push(sha256(readFileSync(f.analysis)));
    } catch {
      // Momentarily absent would be fine too; a rename never exposes a prefix.
    }
  }, 2);

  try {
    const result = await ensureAnalysisAudio(f.slug);
    assert.equal(result.regenerated, true, "the conversion really ran again");
  } finally {
    clearInterval(sampling);
  }

  const second = sha256(await readFile(f.analysis));
  const complete = new Set([first, second]);

  assert.ok(samples.length > 0, "the conversion was actually observed");
  assert.deepEqual(
    samples.filter((sample) => !complete.has(sample)),
    [],
    "no sample caught a partially written file",
  );
  assert.deepEqual(await leftovers(f.slug), []);
});

test("a preparation that fails leaves the previous analysis file intact", async (t) => {
  const f = await audibleTrack(t);

  await ensureAnalysisAudio(f.slug);
  const good = await readFile(f.analysis);

  // Unreadable source audio: the conversion must fail without touching the
  // file that is already published.
  await writeFile(f.beat, "not audio at all");

  await assert.rejects(() => ensureAnalysisAudio(f.slug), {
    code: "ANALYSIS_GENERATION_FAILED",
  });

  assert.deepEqual(await readFile(f.analysis), good);
  assert.deepEqual(await leftovers(f.slug), [], "the staged file is cleaned up");
});

test("preparing one track never blocks another", async (t) => {
  const first = await audibleTrack(t);
  const second = await audibleTrack(t);

  // Different tracks are independent work; nothing here serializes globally.
  const [a, b] = await Promise.all([
    ensureAnalysisAudio(first.slug),
    ensureAnalysisAudio(second.slug),
  ]);

  assert.equal(a.regenerated, true);
  assert.equal(b.regenerated, true);
  assert.notEqual(a.absolutePath, b.absolutePath);
  assert.equal(path.dirname(a.absolutePath) === path.dirname(b.absolutePath), false);
});
