import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TrackError } from "../core/domain/tracks/errors.ts";
import { isEngineFlagValue, readEngineFlag } from "../scripts/cli.ts";

// These tests mean "After Effects is not installed" whatever this machine has:
// an explicit aerender path that does not exist makes discovery report that.
process.env.TOSHI_AERENDER_PATH = "/nonexistent/toshi-test/aerender";

/**
 * `--engine <id>` on the render commands (scripts/cli.ts): absent means
 * Remotion, exactly as before; a value is checked against this installation's
 * engines (adapters/renderEngines.mts) before any track is touched.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = promisify(execFile);

const cli = async (script: string, args: readonly string[]) => {
  try {
    const { stdout, stderr } = await run(process.execPath, [`scripts/${script}.mts`, ...args], {
      cwd: PROJECT_ROOT,
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, output: failed.stdout + failed.stderr };
  }
};

const code = (expected: string) => (error: unknown) =>
  error instanceof TrackError && error.code === expected;

test("no --engine means Remotion; --engine remotion selects it explicitly", () => {
  assert.equal(readEngineFlag(["ghetto-geek"]), "remotion");
  assert.equal(readEngineFlag(["ghetto-geek", "--engine", "remotion"]), "remotion");
});

test("--engine rejects unknown, unavailable and missing values through the engine registry", () => {
  assert.throws(() => readEngineFlag(["x", "--engine", "blender"]), code("INVALID_RENDERER"));
  assert.throws(() => readEngineFlag(["x", "--engine", "premiere"]), code("RENDERER_UNAVAILABLE"));
  assert.throws(() => readEngineFlag(["x", "--engine"]), code("INVALID_RENDERER"));
  assert.throws(() => readEngineFlag(["x", "--engine", "--dry-run"]), code("INVALID_RENDERER"));
});

test("--engine's value is never mistaken for a positional argument", () => {
  const argv = ["--engine", "remotion", "ghetto-geek"];
  assert.deepEqual(
    argv.map((_arg, index) => isEngineFlagValue(argv, index)),
    [false, true, false],
  );
});

test("render-track picks the slug, not the engine, and fails on a bad engine before preparing", async () => {
  const slug = `no-such-${randomUUID()}`;

  // Engine before the slug: the slug is still the track it looks for.
  const explicit = await cli("render-track", ["--engine", "remotion", slug, "--validate-only"]);
  assert.equal(explicit.code, 1);
  assert.match(explicit.output, new RegExp(`Track "${slug}" not found`));

  const unknown = await cli("render-track", [slug, "--engine", "blender"]);
  assert.equal(unknown.code, 1);
  assert.match(unknown.output, /Unknown render engine "blender"/);
  assert.doesNotMatch(unknown.output, /Preparing track/);

  const unavailable = await cli("render-track", [slug, "--engine", "after-effects"]);
  assert.equal(unavailable.code, 1);
  assert.match(unavailable.output, /"after-effects" render engine is not available/);
});

test("the batch render commands validate --engine up front too", async () => {
  for (const [script, args] of [
    ["render-missing", ["--all-tracks", "--dry-run", "--engine", "premiere"]],
    ["content-package", [`no-such-${randomUUID()}`, "--engine", "premiere"]],
    ["content-package-batch", ["--track", `no-such-${randomUUID()}`, "--engine", "premiere"]],
  ] as const) {
    const result = await cli(script, args);
    assert.equal(result.code, 1, script);
    assert.match(result.output, /"premiere" render engine is not available/, script);
  }
});
