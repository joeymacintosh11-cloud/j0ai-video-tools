import type {
  DestinationCapabilities,
  DestinationId,
  PublicationMode,
} from "../domain/publishing/destinations.ts";
import type { PublicationMetadata } from "../domain/publishing/publicationMetadata.ts";
import type { PublicationSourceIdentity } from "../domain/publishing/publicationSource.ts";
import type { PublishProblem } from "../domain/publishing/publishProblems.ts";
import type { CancelSignal } from "./renderEngine.ts";

/**
 * The publishing extension point.
 *
 * The engine (services/publishing/) owns everything around a publication:
 * finding and pinning the export, validation, the job lifecycle, locks,
 * idempotency keys, the receipt and its history. A PublishDestination owns
 * only the conversation with one destination. A YouTube, Instagram or TikTok
 * adapter implements this; so does the local mock (adapters/publishing/).
 *
 * It is deliberately *not* RenderEngine-shaped. A render is a local,
 * repeatable computation whose output the engine publishes itself; a
 * publication is an external side effect that may succeed without the caller
 * finding out. So the contract is built around certainty: every result says
 * whether the publication definitely happened, definitely did not, or is
 * unknown — and unknown fails closed (recovery_required) until recover()
 * proves one or the other.
 *
 * Lifecycle, in the order the engine calls it:
 *
 *   status (registry, without loading) -> validate -> prepare -> publish
 *     -> inspect / recover when needed
 *
 * Pure types, so any host can implement it.
 */

/** Everything an adapter is told about one attempt. */
export type PublishRequest = {
  readonly jobId: string;
  readonly attemptId: string;
  /**
   * Stable for this attempt and only this attempt. An adapter whose platform
   * supports idempotent creation passes it on; one that does not must still
   * use it to make its own retries of *this attempt* safe, and must declare
   * capabilities.idempotentPublish = false.
   */
  readonly idempotencyKey: string;
  readonly accountId: string | null;
  readonly mode: PublicationMode;
  readonly metadata: PublicationMetadata;
  /** The pinned export. */
  readonly source: PublicationSourceIdentity;
  /**
   * Absolute path of that export. Read-only: an adapter never writes, moves
   * or deletes it, and reads it only during prepare(), while the engine holds
   * the export's lock. Never recorded anywhere.
   */
  readonly sourceFile: string;
  /** Absolute path of the track's cover art, when metadata.thumbnail asks for it. Read-only, prepare() only. */
  readonly thumbnailFile: string | null;
};

export type PublishContext = {
  readonly cancelSignal: CancelSignal;
  /** Diagnostics for the person publishing. Never pass secrets. */
  readonly log: (message: string) => void;
};

/**
 * What prepare() captured. After prepare() returns, the engine re-checks that
 * the export is still the pinned one and releases its lock; publish() must
 * then work only from what was captured here.
 */
export type PreparedPublication = {
  readonly request: PublishRequest;
  /** Adapter-private state (a staged copy, an upload session). Opaque to the engine. */
  readonly state: unknown;
  /** Releases anything prepare() created that publish() did not consume. Idempotent. */
  readonly dispose: () => Promise<void>;
};

export type PublishResult =
  /** It is live (or accepted) at the destination. */
  | {
      readonly outcome: "published";
      readonly publicationId: string;
      readonly url: string | null;
      readonly publishedAt: string;
    }
  /** Definitely nothing took effect at the destination. Safe to retry as a new attempt. */
  | { readonly outcome: "failed"; readonly message: string }
  /** Cancelled before anything took effect. */
  | { readonly outcome: "cancelled" }
  /** It may or may not have taken effect. The engine fails closed. */
  | { readonly outcome: "uncertain"; readonly message: string; readonly publicationId: string | null };

/** What reconciliation established about one attempt. */
export type RecoveryResult =
  | {
      readonly outcome: "published";
      readonly publicationId: string;
      readonly url: string | null;
      readonly publishedAt: string;
    }
  | { readonly outcome: "not_published" }
  | { readonly outcome: "unknown"; readonly message: string };

export type RecoveryRequest = {
  readonly jobId: string;
  readonly attemptId: string;
  readonly idempotencyKey: string;
  readonly accountId: string | null;
  /** If the destination named the publication before the outcome was lost. */
  readonly publicationId: string | null;
};

export type RemotePublicationState = {
  readonly publicationId: string;
  readonly state: "published" | "processing" | "removed" | "unknown";
  readonly url: string | null;
};

export type PublishDestination = {
  readonly id: DestinationId;
  /** Destination-specific checks beyond the generic metadata rules and capabilities. */
  readonly validate: (request: Omit<PublishRequest, "sourceFile" | "thumbnailFile">) => readonly PublishProblem[];
  readonly prepare: (request: PublishRequest, context: PublishContext) => Promise<PreparedPublication>;
  readonly publish: (prepared: PreparedPublication, context: PublishContext) => Promise<PublishResult>;
  /** Current state of a publication at the destination; null when it does not know it. */
  readonly inspect: (publicationId: string, accountId: string | null) => Promise<RemotePublicationState | null>;
  /** Present only when capabilities.recover is true. */
  readonly recover?: (request: RecoveryRequest) => Promise<RecoveryResult>;
};

/** The static facts about a destination, known without loading its adapter. */
export type PublishDestinationDescriptor = {
  readonly id: DestinationId;
  readonly displayName: string;
  readonly capabilities: DestinationCapabilities;
};
