import type { DestinationId } from "../domain/publishing/destinations.ts";

/**
 * The secrets boundary for publishing destinations.
 *
 * Future OAuth tokens and API keys are read through this port and nowhere
 * else. They must never be written to track metadata, export manifests,
 * publish jobs, publication receipts, logs or any git-tracked file; only a
 * destination adapter ever receives one, and only for the duration of a call.
 *
 * This milestone ships no implementation that stores anything: the only
 * provider (services/publishing/destinationSettings.ts, `noCredentials`)
 * answers "none" for every destination, which is all the local mock needs.
 * A real provider (an OS keychain, an encrypted local store) plugs in here in
 * the milestone that adds the first network destination.
 */

/** Opaque to everything except the adapter it is for. Never serialised. */
export type DestinationCredential = {
  readonly kind: "oauth" | "api-key";
  /** Read by the adapter only; hosts must not log or return it. */
  readonly reveal: () => string;
};

export type DestinationCredentialProvider = {
  /** Whether a credential exists, without revealing it (for status and configuration checks). */
  readonly has: (destinationId: DestinationId, accountId: string | null) => boolean;
  readonly get: (destinationId: DestinationId, accountId: string | null) => Promise<DestinationCredential | null>;
};
