import { readFileSync } from "node:fs";
import path from "node:path";
import { isDestinationIdShape } from "../../core/domain/publishing/destinations.ts";
import { isAccountId } from "../../core/domain/publishing/publicationReceipt.ts";
import type { DestinationCredentialProvider } from "../../core/ports/destinationCredentials.ts";
import { PROJECT_ROOT } from "../tracks/trackLocations.ts";

/**
 * Machine-local, non-secret destination settings: publishing.local.json.
 *
 *   {
 *     "schemaVersion": 1,
 *     "destinations": {
 *       "local-mock": { "enabled": true, "accountId": "local-dev" }
 *     }
 *   }
 *
 * Gitignored, like delivery.local.json: which accounts this machine publishes
 * as is a fact about one machine. It holds *identifiers* only. A file that
 * contains anything credential-shaped (token, secret, password, key…) is
 * refused as a whole, so a secret pasted here by mistake is reported rather
 * than used, and never copied into a job or receipt.
 *
 * Absent means defaults: every registered local destination enabled, no
 * account. Malformed is reported (destination status says why) and treated as
 * absent for safety: no destination becomes "configured" from a file that
 * could not be read.
 */

export const PUBLISHING_SETTINGS_FILE = path.join(PROJECT_ROOT, "publishing.local.json");
export const PUBLISHING_SETTINGS_VERSION = 1;

export type DestinationSettings = {
  readonly enabled: boolean;
  readonly accountId: string | null;
  /** Adapter-specific, non-secret options (the mock's simulated outcome, say). */
  readonly options: Readonly<Record<string, string | number | boolean>>;
};

export type PublishingSettings = {
  readonly destinations: Readonly<Record<string, DestinationSettings>>;
};

export type PublishingSettingsRead = {
  readonly settings: PublishingSettings;
  readonly problem: string | null;
};

const SECRET_KEY = /token|secret|password|credential|authorization|api[-_]?key|cookie|refresh/i;

export const publishingSettingsFile = (): string =>
  process.env.TOSHI_PUBLISHING_SETTINGS ? path.resolve(process.env.TOSHI_PUBLISHING_SETTINGS) : PUBLISHING_SETTINGS_FILE;

export const parsePublishingSettings = (raw: unknown): PublishingSettingsRead => {
  const fail = (problem: string): PublishingSettingsRead => ({ settings: { destinations: {} }, problem });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("publishing.local.json must be a JSON object.");
  const value = raw as { schemaVersion?: unknown; destinations?: unknown };
  if (value.schemaVersion !== PUBLISHING_SETTINGS_VERSION)
    return fail(`publishing.local.json schemaVersion must be ${PUBLISHING_SETTINGS_VERSION}.`);
  const findSecret = (input: unknown, at: string): string | null => {
    if (input === null || typeof input !== "object") return null;
    for (const [key, inner] of Object.entries(input as Record<string, unknown>)) {
      if (SECRET_KEY.test(key)) return `${at}${key}`;
      const nested = findSecret(inner, `${at}${key}.`);
      if (nested) return nested;
    }
    return null;
  };
  const secret = findSecret(value, "");
  if (secret !== null)
    return fail(`publishing.local.json must not contain credentials ("${secret}"). Credentials are never read from settings files.`);
  const destinations: Record<string, DestinationSettings> = {};
  const entries = value.destinations ?? {};
  if (typeof entries !== "object" || entries === null || Array.isArray(entries)) return fail('"destinations" must be an object.');
  for (const [id, entry] of Object.entries(entries as Record<string, unknown>)) {
    if (!isDestinationIdShape(id)) return fail(`"${id}" is not a destination id.`);
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return fail(`destinations.${id} must be an object.`);
    const { enabled = true, accountId = null, ...options } = entry as Record<string, unknown>;
    if (typeof enabled !== "boolean") return fail(`destinations.${id}.enabled must be true or false.`);
    if (accountId !== null && !isAccountId(accountId)) return fail(`destinations.${id}.accountId must be a short identifier.`);
    for (const [key, option] of Object.entries(options)) {
      if (!["string", "number", "boolean"].includes(typeof option)) return fail(`destinations.${id}.${key} must be a plain value.`);
    }
    destinations[id] = { enabled, accountId: accountId as string | null, options: options as DestinationSettings["options"] };
  }
  return { settings: { destinations }, problem: null };
};

export const readPublishingSettings = (file: string = publishingSettingsFile()): PublishingSettingsRead => {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { settings: { destinations: {} }, problem: null };
    return { settings: { destinations: {} }, problem: `publishing.local.json could not be read: ${(error as Error).message}` };
  }
  try {
    return parsePublishingSettings(JSON.parse(text));
  } catch {
    return { settings: { destinations: {} }, problem: "publishing.local.json is not valid JSON." };
  }
};

/** Defaults for a destination with no entry: enabled, no account, no options. */
export const destinationSettingsFor = (settings: PublishingSettings, id: string): DestinationSettings =>
  settings.destinations[id] ?? { enabled: true, accountId: null, options: {} };

/**
 * The only credential provider in this milestone: there are none. Nothing in
 * the product stores a credential yet; the first network destination brings a
 * real provider (an OS keychain), behind the same port.
 */
export const noCredentials: DestinationCredentialProvider = {
  has: () => false,
  get: async () => null,
};
