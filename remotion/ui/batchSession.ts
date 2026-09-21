import type { ContentPackageBatchJobReferenceView } from "../src/domain/api/views.ts";
import {
  PLATFORM_IDS,
  PLATFORM_PROFILES,
  isPlatformId,
  type PlatformId,
} from "../src/domain/content/platformProfiles.ts";
import { isValidSlug } from "../src/domain/tracks/slug.ts";

/** Browser-local reconstruction hints for the Batch Content Package panel. */
export const BATCH_SESSION_STORAGE_KEY = "toshi.visualizer.batch-content-package.v1";
export const BATCH_SESSION_SCHEMA_VERSION = 1;
export const BATCH_SESSION_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const BATCH_SESSION_MAX_TRACKS = 100;
export const BATCH_SESSION_MAX_JOBS = BATCH_SESSION_MAX_TRACKS * PLATFORM_IDS.length;
const MAX_STORED_PLATFORM_ENTRIES = PLATFORM_IDS.length * 4;

export type BatchSessionMode = "intent" | "full" | "platforms";

export type BatchSessionJobReference = Omit<Pick<
  ContentPackageBatchJobReferenceView,
  "actionId" | "slug" | "platformId" | "presetId" | "jobId"
>, "jobId"> & { readonly jobId: string };

export type BatchSession = {
  readonly schemaVersion: typeof BATCH_SESSION_SCHEMA_VERSION;
  readonly savedAt: string;
  readonly selectedSlugs: readonly string[];
  readonly mode: BatchSessionMode;
  readonly platforms: readonly PlatformId[];
  readonly jobReferences: readonly BatchSessionJobReference[];
  readonly panelOpen: boolean;
};

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const uniqueBounded = <T>(
  value: unknown,
  limit: number,
  validate: (entry: unknown) => entry is T,
): readonly T[] | null => {
  if (!Array.isArray(value) || value.length > limit) return null;
  const result: T[] = [];
  const seen = new Set<unknown>();
  for (const entry of value) {
    if (!validate(entry) || seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
};

const isSafeId = (value: unknown, maxLength: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maxLength &&
  /^[a-zA-Z0-9:_-]+$/.test(value);

const parseJobReference = (value: unknown): BatchSessionJobReference | null => {
  if (!isRecord(value) || !isValidSlug(value.slug) || !isPlatformId(value.platformId)) return null;
  const presetId = PLATFORM_PROFILES[value.platformId].presetId;
  const actionId = `${value.slug}::${value.platformId}::${presetId}`;
  if (value.presetId !== presetId || value.actionId !== actionId || !isSafeId(value.jobId, 128)) return null;
  return { actionId, slug: value.slug, platformId: value.platformId, presetId, jobId: value.jobId };
};

const parseJobReferences = (value: unknown): readonly BatchSessionJobReference[] | null => {
  if (!Array.isArray(value) || value.length > BATCH_SESSION_MAX_JOBS) return null;
  const result: BatchSessionJobReference[] = [];
  const seenActions = new Set<string>();
  for (const entry of value) {
    const parsed = parseJobReference(entry);
    if (!parsed || seenActions.has(parsed.actionId)) continue;
    seenActions.add(parsed.actionId);
    result.push(parsed);
  }
  return result;
};

/** Parses and bounds untrusted storage. Invalid/expired payloads are ignored wholesale. */
export const parseBatchSession = (
  raw: string | null,
  now = Date.now(),
): BatchSession | null => {
  if (raw === null || raw.length > 100_000) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.schemaVersion !== BATCH_SESSION_SCHEMA_VERSION) return null;
  const savedAtMs = typeof value.savedAt === "string" ? Date.parse(value.savedAt) : Number.NaN;
  if (!Number.isFinite(savedAtMs) || savedAtMs > now + 60_000 || now - savedAtMs > BATCH_SESSION_MAX_AGE_MS) return null;
  const selectedSlugs = uniqueBounded(value.selectedSlugs, BATCH_SESSION_MAX_TRACKS, isValidSlug);
  const platforms = uniqueBounded(value.platforms, MAX_STORED_PLATFORM_ENTRIES, isPlatformId);
  const jobReferences = parseJobReferences(value.jobReferences);
  if (!selectedSlugs || selectedSlugs.length === 0 || !platforms || !jobReferences) return null;
  if (value.mode !== "intent" && value.mode !== "full" && value.mode !== "platforms") return null;
  const mode = value.mode === "platforms" && platforms.length === 0 ? "intent" : value.mode;
  if (typeof value.panelOpen !== "boolean") return null;
  return {
    schemaVersion: BATCH_SESSION_SCHEMA_VERSION,
    savedAt: new Date(savedAtMs).toISOString(),
    selectedSlugs,
    mode,
    platforms,
    jobReferences,
    panelOpen: value.panelOpen,
  };
};

/** Drops deleted tracks and references outside the restored catalogue selection. */
export const reconcileBatchSession = (
  session: BatchSession,
  catalogueSlugs: ReadonlySet<string>,
): BatchSession | null => {
  const selectedSlugs = session.selectedSlugs.filter((slug) => catalogueSlugs.has(slug));
  if (selectedSlugs.length === 0) return null;
  const selected = new Set(selectedSlugs);
  return {
    ...session,
    selectedSlugs,
    jobReferences: session.jobReferences.filter((reference) => selected.has(reference.slug)),
  };
};

export const loadBatchSession = (
  storage: StorageLike,
  now = Date.now(),
): BatchSession | null => {
  let raw: string | null;
  try {
    raw = storage.getItem(BATCH_SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  const session = parseBatchSession(raw, now);
  if (!session && raw !== null) clearBatchSession(storage);
  return session;
};

export const saveBatchSession = (
  storage: StorageLike,
  value: Omit<BatchSession, "schemaVersion" | "savedAt">,
  now = Date.now(),
): BatchSession => {
  const session: BatchSession = {
    schemaVersion: BATCH_SESSION_SCHEMA_VERSION,
    savedAt: new Date(now).toISOString(),
    ...value,
  };
  try {
    storage.setItem(BATCH_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Storage can be disabled or full. The live workflow remains usable.
  }
  return session;
};

export const clearBatchSession = (storage: StorageLike): void => {
  try {
    storage.removeItem(BATCH_SESSION_STORAGE_KEY);
  } catch {
    // Clearing browser intent must never make the live workflow unusable.
  }
};

export const toSessionJobReferences = (
  references: readonly ContentPackageBatchJobReferenceView[],
): readonly BatchSessionJobReference[] =>
  parseJobReferences(references) ?? [];

/** New exact references replace older references for the same action. */
export const mergeSessionJobReferences = (
  previous: readonly BatchSessionJobReference[],
  incoming: readonly BatchSessionJobReference[],
): readonly BatchSessionJobReference[] => {
  const merged = new Map(previous.map((reference) => [reference.actionId, reference]));
  for (const reference of incoming) merged.set(reference.actionId, reference);
  return [...merged.values()].slice(-BATCH_SESSION_MAX_JOBS);
};

export const pruneSessionJobIds = (
  references: readonly BatchSessionJobReference[],
  jobIds: ReadonlySet<string>,
): readonly BatchSessionJobReference[] =>
  references.filter((reference) => !jobIds.has(reference.jobId));
