import { accessSync, constants, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { readConfiguredAerenderPath } from "./afterEffectsConfig.mts";

/**
 * Finds After Effects' command-line renderer, aerender.
 *
 * Never assumes an install path. In order:
 *
 *  1. TOSHI_AERENDER_PATH (environment)          — explicit
 *  2. "aerenderPath" in after-effects.local.json — explicit
 *  3. `aerender` on PATH
 *  4. /Applications/Adobe After Effects <version>/aerender (macOS), newest first
 *
 * An explicit setting is authoritative: if it points somewhere unusable the
 * result says so rather than quietly picking a different After Effects. The
 * result always says where the binary came from, or everywhere that was
 * looked, so "which aerender is this using?" has a direct answer.
 *
 * Pure apart from the filesystem access in `defaultDiscoveryFs`, which tests
 * replace.
 */

export type AerenderSource = "env" | "config" | "path" | "applications";

export type AerenderDiscovery =
  | { readonly found: true; readonly path: string; readonly source: AerenderSource }
  | {
      readonly found: false;
      /** Every candidate looked at, in order. */
      readonly tried: readonly string[];
      /** Set when an explicit setting was wrong, naming that setting. */
      readonly problem: string | null;
    };

export type DiscoveryFs = {
  readonly isExecutableFile: (file: string) => boolean;
  /** Entry names in a directory; empty when it cannot be read. */
  readonly list: (dir: string) => readonly string[];
};

export const defaultDiscoveryFs: DiscoveryFs = {
  isExecutableFile: (file) => {
    try {
      accessSync(file, constants.X_OK);
      return statSync(file).isFile();
    } catch {
      return false;
    }
  },
  list: (dir) => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

export const AERENDER_ENV = "TOSHI_AERENDER_PATH";
export const APPLICATIONS_DIR = "/Applications";
const BINARY = "aerender";

/** "Adobe After Effects 2025" before "Adobe After Effects 2024" before "… CC 2019". */
const newestFirst = (a: string, b: string): number => {
  const year = (name: string) => Number(name.match(/(\d{4})/)?.[1] ?? 0);
  return year(b) - year(a) || b.localeCompare(a);
};

export const discoverAerender = (options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** aerenderPath from after-effects.local.json, if any. */
  readonly configuredPath: string | null;
  readonly platform: string;
  readonly fs?: DiscoveryFs;
}): AerenderDiscovery => {
  const fs = options.fs ?? defaultDiscoveryFs;
  const tried: string[] = [];

  const explicit: readonly [AerenderSource, string | undefined, string][] = [
    ["env", options.env[AERENDER_ENV], `${AERENDER_ENV}`],
    ["config", options.configuredPath ?? undefined, `"aerenderPath" in after-effects.local.json`],
  ];
  for (const [source, value, setting] of explicit) {
    if (value === undefined || value === "") continue;
    tried.push(value);
    if (fs.isExecutableFile(value)) return { found: true, path: value, source };
    return {
      found: false,
      tried,
      problem: `${setting} points to ${value}, which is not an executable file.`,
    };
  }

  for (const dir of (options.env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, BINARY);
    tried.push(candidate);
    if (fs.isExecutableFile(candidate)) return { found: true, path: candidate, source: "path" };
  }

  if (options.platform === "darwin") {
    const installs = fs
      .list(APPLICATIONS_DIR)
      .filter((name) => name.startsWith("Adobe After Effects"))
      .sort(newestFirst);
    if (installs.length === 0) tried.push(path.join(APPLICATIONS_DIR, "Adobe After Effects */aerender"));
    for (const install of installs) {
      const candidate = path.join(APPLICATIONS_DIR, install, BINARY);
      tried.push(candidate);
      if (fs.isExecutableFile(candidate)) return { found: true, path: candidate, source: "applications" };
    }
  }

  return { found: false, tried, problem: null };
};

/** One sentence for RENDERER_UNAVAILABLE: what is wrong and how to fix it. */
export const describeAerenderNotFound = (
  discovery: Extract<AerenderDiscovery, { found: false }>,
): string =>
  discovery.problem !== null
    ? `${discovery.problem} Point it at After Effects' aerender, or remove it to search automatically.`
    : `After Effects' aerender was not found (searched PATH${
        discovery.tried.some((entry) => entry.startsWith(APPLICATIONS_DIR)) ? ` and ${APPLICATIONS_DIR}` : ""
      }). Install After Effects, or set ${AERENDER_ENV} or "aerenderPath" in after-effects.local.json to its aerender.`;

/** This machine: the environment, after-effects.local.json, PATH and /Applications. */
export const discoverInstalledAerender = (): AerenderDiscovery =>
  discoverAerender({
    env: process.env,
    configuredPath: readConfiguredAerenderPath(),
    platform: process.platform,
  });
