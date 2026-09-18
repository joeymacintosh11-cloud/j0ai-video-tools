import { existsSync, realpathSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { DELIVERY_SETTINGS_VERSION } from "../../src/domain/delivery/deliveryPaths.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { withFileMutation, writeAtomicFile } from "../tracks/atomicFile.ts";
import { PROJECT_ROOT } from "../tracks/trackLocations.ts";

/**
 * Where delivered copies go on this machine.
 *
 * Kept out of track metadata on purpose. An absolute path is specific to one
 * computer and one person's folder layout, so committing it into a track's
 * metadata.json would leak it into git and break on any other machine. Track
 * metadata carries only a portable folder name; this file carries the root.
 *
 * Absent or unset means delivery is simply off, and the tool behaves exactly as
 * it did before destinations existed.
 */

export const DELIVERY_SETTINGS_FILE = path.join(
  PROJECT_ROOT,
  "delivery.local.json",
);

export type DeliverySettings = {
  readonly schemaVersion: number;
  /** Absolute, existing directory, or null when delivery is off. */
  readonly root: string | null;
  /** Copy automatically after a successful render. Off unless asked for. */
  readonly autoDeliver: boolean;
  /** Rewrite a track's release bundle after a successful delivery. Opt-in. */
  readonly autoUpdateReleaseBundle: boolean;
};

export const DELIVERY_OFF: DeliverySettings = {
  schemaVersion: DELIVERY_SETTINGS_VERSION,
  root: null,
  autoDeliver: false,
  autoUpdateReleaseBundle: false,
};

const invalid = (message: string): never => {
  throw new TrackError(trackIssue("INVALID_REQUEST", message));
};

/**
 * Checks a destination root hard, once, at the point it is configured.
 *
 * It must already exist: creating arbitrary directories from a typed-in path is
 * how a typo becomes a stray folder tree somewhere unexpected. Symlinks are
 * resolved so the stored root is the real location every later containment
 * check is made against. A root inside the project is refused outright —
 * delivering into `out/` would have the tool copying its own output back into
 * its own input tree.
 */
export const assertDeliveryRoot = (value: unknown): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    return invalid(
      "Provide an absolute folder path for the export destination, or null to turn delivery off.",
    );
  }

  const raw = value.trim();

  if (!path.isAbsolute(raw)) {
    return invalid(
      `The export destination must be an absolute path, e.g. /Users/you/Movies/Toshi Exports. Received "${raw}".`,
    );
  }

  if (!existsSync(raw)) {
    return invalid(
      `The export destination "${raw}" does not exist. Create the folder first, then set it here.`,
    );
  }

  const root = realpathSync(raw);

  if (!statSync(root).isDirectory()) {
    return invalid(`The export destination "${raw}" is not a folder.`);
  }

  const project = realpathSync(PROJECT_ROOT);
  if (root === project || root.startsWith(`${project}${path.sep}`)) {
    return invalid(
      `The export destination must be outside the project folder. "${root}" is inside ${project}.`,
    );
  }

  return root;
};

/**
 * Current settings, or delivery-off.
 *
 * A missing, unreadable or malformed file means off rather than an error: a
 * broken local config must not stop the app from rendering. A root that has
 * since been removed or unmounted is reported by delivery itself, which is
 * where the user can act on it.
 */
export const readDeliverySettings = async (): Promise<DeliverySettings> => {
  let raw: string;
  try {
    raw = await readFile(DELIVERY_SETTINGS_FILE, "utf8");
  } catch {
    return DELIVERY_OFF;
  }

  try {
    const value = JSON.parse(raw) as Partial<DeliverySettings>;
    const root =
      typeof value.root === "string" && value.root.trim().length > 0
        ? value.root.trim()
        : null;

    return {
      schemaVersion: DELIVERY_SETTINGS_VERSION,
      root,
      autoDeliver: value.autoDeliver === true,
      autoUpdateReleaseBundle: value.autoUpdateReleaseBundle === true,
    };
  } catch {
    return DELIVERY_OFF;
  }
};

export type DeliverySettingsPatch = {
  /** Absolute path, or null to turn delivery off. Omitted leaves it alone. */
  readonly root?: string | null;
  readonly autoDeliver?: boolean;
  readonly autoUpdateReleaseBundle?: boolean;
};

/** Validates, then writes atomically so a crash cannot leave half a config. */
export const writeDeliverySettings = async (
  patch: DeliverySettingsPatch,
): Promise<DeliverySettings> =>
  withFileMutation(DELIVERY_SETTINGS_FILE, async () => {
    const current = await readDeliverySettings();

    const root =
      patch.root === undefined
        ? current.root
        : patch.root === null
          ? null
          : assertDeliveryRoot(patch.root);

    for (const flag of ["autoDeliver", "autoUpdateReleaseBundle"] as const) {
      if (patch[flag] !== undefined && typeof patch[flag] !== "boolean") {
        invalid(`"${flag}" must be true or false.`);
      }
    }

    const next: DeliverySettings = {
      schemaVersion: DELIVERY_SETTINGS_VERSION,
      root,
      autoDeliver: patch.autoDeliver ?? current.autoDeliver,
      autoUpdateReleaseBundle:
        patch.autoUpdateReleaseBundle ?? current.autoUpdateReleaseBundle,
    };

    await writeAtomicFile(DELIVERY_SETTINGS_FILE, (handle) =>
      handle.writeFile(`${JSON.stringify(next, null, 2)}\n`, "utf-8"),
    );

    return next;
  });

/**
 * The root as it stands right now, or null with the reason it is unusable.
 *
 * Checked at delivery time as well as at configuration time, because a synced
 * or external destination can disappear between the two.
 */
export const resolveDeliveryRoot = (
  settings: DeliverySettings,
): { readonly root: string | null; readonly problem: string | null } => {
  if (settings.root === null) return { root: null, problem: null };

  try {
    const root = assertDeliveryRoot(settings.root);
    return { root, problem: null };
  } catch {
    return {
      root: null,
      problem: `The export destination "${settings.root}" is not available. Reconnect or remount it, or set a different folder.`,
    };
  }
};
