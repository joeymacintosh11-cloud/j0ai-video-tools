import {
  assertDestinationIdShape,
  RESERVED_DESTINATION_IDS,
  RESERVED_DESTINATION_LABELS,
  type DestinationId,
  type DestinationStatus,
} from "../domain/publishing/destinations.ts";
import { TrackError, trackIssue } from "../domain/tracks/errors.ts";
import type { PublishDestination, PublishDestinationDescriptor } from "./publishDestination.ts";

/**
 * Looks up publishing destinations by id.
 *
 * Shaped like the render engine registry (renderEngineRegistry.ts): callers
 * never import an adapter, they ask for a destination by id and get either it
 * or a clear error. Descriptors (name, capabilities) are static, so listing
 * destinations, checking formats and explaining unavailability never loads an
 * adapter; only resolve() does.
 *
 * An unknown id always fails (PUBLISH_DESTINATION_UNKNOWN). Nothing here ever
 * substitutes another destination for the one asked for.
 *
 * Pure: the instance with real adapters lives in adapters/publishDestinations.mts.
 */

export type DestinationConfiguration = {
  /** Null when usable; otherwise what to configure, in words for the person on this machine. */
  readonly problem: string | null;
  /** The account/profile it would publish as. An identifier, never a credential. */
  readonly accountId: string | null;
};

export type PublishDestinationRegistration = {
  readonly descriptor: PublishDestinationDescriptor;
  readonly load: () => Promise<PublishDestination>;
  /** Installed/available? Null when it is. Asked on every check, synchronously, without loading. */
  readonly probe?: () => string | null;
  /** Configured (account, credentials present)? Asked on every check. Never returns a secret. */
  readonly configured?: () => DestinationConfiguration;
};

export type PublishDestinationRegistry = {
  /** Every registered destination, then every reserved id without an adapter. */
  readonly status: () => readonly DestinationStatus[];
  /** One destination's status. Unknown ids throw PUBLISH_DESTINATION_UNKNOWN. */
  readonly describe: (id: unknown) => DestinationStatus;
  /** Registered and ready, or throws: unknown, or a known id that cannot publish here. */
  readonly resolve: (id: unknown) => Promise<PublishDestination>;
};

export const createPublishDestinationRegistry = (
  registrations: readonly PublishDestinationRegistration[],
): PublishDestinationRegistry => {
  const byId = new Map<DestinationId, PublishDestinationRegistration>();
  for (const registration of registrations) {
    const { id } = registration.descriptor;
    assertDestinationIdShape(id);
    if (byId.has(id)) throw new Error(`Publishing destination "${id}" is registered twice.`);
    if (registration.descriptor.capabilities.formats.length === 0)
      throw new Error(`Publishing destination "${id}" declares no formats.`);
    byId.set(id, registration);
  }

  const statusOf = (registration: PublishDestinationRegistration): DestinationStatus => {
    const { id, displayName, capabilities } = registration.descriptor;
    const base = { id, displayName, implemented: true, capabilities };
    const missing = registration.probe?.() ?? null;
    if (missing !== null) return { ...base, state: "unavailable", problem: missing, accountId: null };
    const configuration = registration.configured?.() ?? { problem: null, accountId: null };
    return configuration.problem === null
      ? { ...base, state: "ready", problem: null, accountId: configuration.accountId }
      : { ...base, state: "not_configured", problem: configuration.problem, accountId: configuration.accountId };
  };

  const reserved = (id: (typeof RESERVED_DESTINATION_IDS)[number]): DestinationStatus => ({
    id,
    displayName: RESERVED_DESTINATION_LABELS[id],
    implemented: false,
    state: "unavailable",
    problem: `Publishing to ${RESERVED_DESTINATION_LABELS[id]} is not implemented in this installation yet.`,
    accountId: null,
    capabilities: null,
  });

  const unknown = (id: unknown): never => {
    const known = [...byId.keys(), ...RESERVED_DESTINATION_IDS.filter((r) => !byId.has(r))];
    throw new TrackError(
      trackIssue(
        "PUBLISH_DESTINATION_UNKNOWN",
        `Unknown publishing destination ${JSON.stringify(id)}. Known: ${known.join(", ")}.`,
      ),
    );
  };

  const describe = (id: unknown): DestinationStatus => {
    if (typeof id !== "string") return unknown(id);
    const registration = byId.get(id);
    if (registration !== undefined) return statusOf(registration);
    const reservedId = RESERVED_DESTINATION_IDS.find((entry) => entry === id);
    return reservedId === undefined ? unknown(id) : reserved(reservedId);
  };

  return {
    status: () => [
      ...[...byId.values()].map(statusOf),
      ...RESERVED_DESTINATION_IDS.filter((id) => !byId.has(id)).map(reserved),
    ],
    describe,
    resolve: async (id) => {
      const status = describe(id);
      if (status.state !== "ready") {
        throw new TrackError(
          trackIssue("PUBLISH_JOB_CONFLICT", `${status.displayName} cannot publish here: ${status.problem ?? status.state}`),
        );
      }
      const destination = await byId.get(status.id)!.load();
      // A registration mistake, not a user error.
      if (destination.id !== status.id)
        throw new Error(`Publishing destination registered as "${status.id}" reports id "${destination.id}".`);
      return destination;
    },
  };
};
