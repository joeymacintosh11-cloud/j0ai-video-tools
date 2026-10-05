import { isDestinationIdShape, PUBLICATION_MODES, PUBLICATION_VISIBILITIES, type DestinationId, type PublicationMode } from "./destinations.ts";
import type { PublicationMetadata } from "./publicationMetadata.ts";
import {
  isPublicationSourceIdentity,
  sameSourceIdentity,
  type PublicationSourceIdentity,
} from "./publicationSource.ts";
import {
  IDEMPOTENCY_KEY_PATTERN,
  PUBLISH_ATTEMPT_ID_PATTERN,
  PUBLISH_JOB_ID_PATTERN,
  currentAttempt,
  type PublishJob,
} from "./publishJob.ts";

/**
 * Proof that one attempt of one job was published.
 *
 * Kept apart from everything rendering writes: receipts live in the
 * publishing store (out/.publishing/receipts.jsonl), append-only, and are
 * never written into export manifests, content-library records or delivery
 * receipts — none of which change when something is published. A receipt
 * stays renderer-aware through its `source`, which is the exact export
 * identity the job pinned (slug, format, renderer, manifest fingerprint, file).
 *
 * Immutable snapshot: the metadata as published, not as it is later edited.
 * Never holds credentials, tokens or absolute paths. `url` must be http(s)
 * (or the mock destination's own mock: scheme) and carry no user info.
 */

export const PUBLICATION_RECEIPT_SCHEMA_VERSION = 1;
export const PUBLICATION_RECEIPT_ID_PATTERN = /^rcp_[a-f0-9]{24}$/;

export type PublicationReceipt = {
  readonly schemaVersion: number;
  /** Derived from the attempt's idempotency key, so one attempt can only ever have one receipt id. */
  readonly receiptId: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly destination: { readonly id: DestinationId; readonly accountId: string | null };
  /** The destination's own id for the publication (a video id, a media id). */
  readonly publicationId: string;
  readonly url: string | null;
  readonly mode: PublicationMode;
  /** When the destination says it was published. */
  readonly publishedAt: string;
  /** When this receipt was written. */
  readonly recordedAt: string;
  readonly source: PublicationSourceIdentity;
  readonly metadata: PublicationMetadata;
};

const PUBLICATION_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9._@:-]{1,128}$/;
/** Field names that would suggest a credential slipped into a receipt. */
const SECRET_KEY = /token|secret|password|credential|authorization|api[-_]?key|cookie/i;

export const isAccountId = (value: unknown): value is string =>
  typeof value === "string" && ACCOUNT_ID_PATTERN.test(value);

export const isSafePublicationUrl = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      ["https:", "http:", "mock:"].includes(url.protocol) &&
      url.username === "" &&
      url.password === "" &&
      ![...url.searchParams.keys()].some((key) => SECRET_KEY.test(key))
    );
  } catch {
    return false;
  }
};

const containsSecretKey = (value: unknown): boolean =>
  value !== null &&
  typeof value === "object" &&
  Object.entries(value as Record<string, unknown>).some(
    ([key, inner]) => SECRET_KEY.test(key) || containsSecretKey(inner),
  );

const isMetadataSnapshot = (value: unknown): value is PublicationMetadata => {
  const v = value as PublicationMetadata | null;
  return (
    v !== null &&
    typeof v === "object" &&
    typeof v.title === "string" &&
    v.title.length > 0 &&
    typeof v.description === "string" &&
    Array.isArray(v.tags) &&
    v.tags.every((tag) => typeof tag === "string") &&
    PUBLICATION_VISIBILITIES.includes(v.visibility) &&
    (v.scheduledAt === null || (typeof v.scheduledAt === "string" && Number.isFinite(Date.parse(v.scheduledAt)))) &&
    (v.thumbnail === null || v.thumbnail?.source === "track-cover")
  );
};

export type ReceiptParse =
  | { readonly receipt: PublicationReceipt; readonly problem: null }
  | { readonly receipt: null; readonly problem: string };

/** Structural validation of an untrusted receipt (from disk, or built from adapter output). */
export const parsePublicationReceipt = (raw: unknown): ReceiptParse => {
  const fail = (problem: string): ReceiptParse => ({ receipt: null, problem });
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return fail("not an object");
  const v = raw as PublicationReceipt;
  if (v.schemaVersion !== PUBLICATION_RECEIPT_SCHEMA_VERSION) return fail(`unsupported schemaVersion ${JSON.stringify(v.schemaVersion)}`);
  if (typeof v.receiptId !== "string" || !PUBLICATION_RECEIPT_ID_PATTERN.test(v.receiptId)) return fail("invalid receiptId");
  if (typeof v.jobId !== "string" || !PUBLISH_JOB_ID_PATTERN.test(v.jobId)) return fail("invalid jobId");
  if (typeof v.attemptId !== "string" || !PUBLISH_ATTEMPT_ID_PATTERN.test(v.attemptId)) return fail("invalid attemptId");
  if (typeof v.idempotencyKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(v.idempotencyKey)) return fail("invalid idempotencyKey");
  if (!isDestinationIdShape(v.destination?.id)) return fail("invalid destination id");
  if (v.destination.accountId !== null && !isAccountId(v.destination.accountId)) return fail("invalid account id");
  if (typeof v.publicationId !== "string" || !PUBLICATION_ID_PATTERN.test(v.publicationId)) return fail("invalid publicationId");
  if (v.url !== null && !isSafePublicationUrl(v.url)) return fail("url must be an http(s) URL without credentials, or null");
  if (!PUBLICATION_MODES.includes(v.mode)) return fail("invalid mode");
  if (typeof v.publishedAt !== "string" || !Number.isFinite(Date.parse(v.publishedAt))) return fail("invalid publishedAt");
  if (typeof v.recordedAt !== "string" || !Number.isFinite(Date.parse(v.recordedAt))) return fail("invalid recordedAt");
  if (!isPublicationSourceIdentity(v.source)) return fail("invalid source export identity");
  if (!isMetadataSnapshot(v.metadata)) return fail("invalid metadata snapshot");
  if (containsSecretKey(v)) return fail("receipt carries a credential-like field");
  return { receipt: v, problem: null };
};

/**
 * Whether a structurally valid receipt really belongs to this job's current
 * attempt and its pinned export. Null when it does; otherwise why not. This
 * is the check a job must pass to become `published`.
 */
export const receiptMismatch = (job: PublishJob, receipt: PublicationReceipt): string | null => {
  const attempt = currentAttempt(job);
  if (attempt === null) return "the job has no attempt";
  if (receipt.jobId !== job.jobId) return "receipt is for another job";
  if (receipt.attemptId !== attempt.attemptId) return "receipt is for another attempt";
  if (receipt.idempotencyKey !== attempt.idempotencyKey) return "receipt idempotency key does not match the attempt";
  if (receipt.destination.id !== job.destinationId) return "receipt is for another destination";
  if (receipt.destination.accountId !== job.accountId) return "receipt is for another account";
  if (job.source === null || !sameSourceIdentity(receipt.source, job.source))
    return "receipt source export differs from the job's pinned export";
  return null;
};
