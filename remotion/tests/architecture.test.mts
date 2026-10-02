import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Layer boundaries, enforced.
 *
 * ARCHITECTURE.md describes a reusable core with adapters around it. These
 * tests read every source file's import specifiers and fail when a layer
 * reaches somewhere it must not, so a boundary break shows up in `npm test`
 * rather than the next time someone tries to reuse the core elsewhere.
 */

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts"];

const sourceFilesUnder = (relativeDir: string): string[] => {
  const absolute = path.join(PROJECT_ROOT, relativeDir);
  return readdirSync(absolute, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && SOURCE_EXTENSIONS.includes(path.extname(entry.name)))
    .map((entry) => path.relative(PROJECT_ROOT, path.join(entry.parentPath, entry.name)));
};

// Statements must start a line, so prose like `moved from "x"` inside a string
// or comment is not mistaken for an import.
const IMPORT_PATTERN =
  /^\s*(?:import|export)\b[^;'"`]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm;

const importsOf = (file: string): string[] => {
  const source = readFileSync(path.join(PROJECT_ROOT, file), "utf8");
  return [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1] ?? match[2] ?? match[3]);
};

/** The project-relative path a relative specifier points at; null for packages. */
const resolveRelative = (file: string, specifier: string): string | null =>
  specifier.startsWith(".")
    ? path.relative(PROJECT_ROOT, path.resolve(PROJECT_ROOT, path.dirname(file), specifier))
    : null;

const isUnder = (projectPath: string, dir: string): boolean =>
  projectPath === dir || projectPath.startsWith(`${dir}${path.sep}`);

const violations = (
  dir: string,
  isForbidden: (specifier: string, target: string | null) => boolean,
): string[] =>
  sourceFilesUnder(dir).flatMap((file) =>
    importsOf(file)
      .filter((specifier) => isForbidden(specifier, resolveRelative(file, specifier)))
      .map((specifier) => `${file} imports "${specifier}"`),
  );

test("the import scanner sees the imports it is meant to police", () => {
  // Guards the guard: if the pattern silently matched nothing, every boundary
  // test below would pass vacuously.
  const imports = importsOf("tests/architecture.test.mts");
  assert.ok(imports.includes("node:assert/strict"));
  assert.ok(imports.includes("node:fs"));
  assert.ok(sourceFilesUnder("core").length > 10);
});

test("core/ is platform-independent: no Node, React, Remotion or any other package", () => {
  // Pure TypeScript only, so the same engine logic can run in Node, a browser,
  // a Remotion bundle, or a future Premiere Pro / After Effects panel.
  assert.deepEqual(
    violations("core", (specifier, target) => target === null),
    [],
  );
});

test("core/ never reaches outward into an adapter or app", () => {
  assert.deepEqual(
    violations("core", (_specifier, target) => target !== null && !isUnder(target, "core")),
    [],
  );
});

test("services, server and CLI depend on the core render contract, not on the Remotion composition", () => {
  // They pass VisualizerProps (core/domain/video/visualizerProps.ts) around;
  // only a render adapter, and the web UI's live preview, touch the composition.
  for (const dir of ["services", "server", "scripts"]) {
    assert.deepEqual(
      violations(dir, (_specifier, target) => target !== null && isUnder(target, "src")),
      [],
      dir,
    );
  }
});

const isRemotionPackage = (specifier: string): boolean =>
  specifier === "remotion" || specifier.startsWith("@remotion/");

test("the engine and its hosts never call Remotion directly", () => {
  // Rendering goes through the RenderEngine port (core/ports/renderEngine.ts);
  // only adapters/remotion/ implements it with Remotion. The web UI's live
  // <Player> preview is the one other, deliberate, Remotion consumer.
  for (const dir of ["services", "server", "scripts"]) {
    assert.deepEqual(
      violations(dir, (specifier) => isRemotionPackage(specifier)),
      [],
      dir,
    );
  }
});

test("the engine (services/) does not depend on any adapter", () => {
  // Adapters are plugged in by the entry points (CLI scripts, render worker);
  // services/ only ever sees the port.
  assert.deepEqual(
    violations("services", (_specifier, target) => target !== null && isUnder(target, "adapters")),
    [],
  );
});
