import { TrackError, trackIssue } from "../tracks/errors.ts";
import type { RenderPresetId } from "../video/renderPresets.ts";

/**
 * Publishing destinations: where a finished export can be *published* to.
 *
 * Rendering produces an export (out/<slug>[/<renderer>]/<preset>.mp4).
 * Delivery copies a current export into a local folder. Publishing hands a
 * current export, plus publication metadata, to a destination adapter that
 * makes it public somewhere and returns a receipt. This module only names
 * destinations and describes what they can accept; which ones exist on this
 * machine is decided by the registered adapters
 * (adapters/publishDestinations.mts), exactly like renderers.
 *
 * Pure and browser-safe.
 */

/**
 * A destination id is a short, stable, lowercase name. Unlike renderer ids it
 * is not a closed union: a future adapter registers a new id without a core
 * change. A handful are reserved so that naming a platform that has no adapter
 * yet fails with "not implemented" rather than "unknown".
 */
export type DestinationId = string;

export const DESTINATION_ID_PATTERN = /^[a-z][a-z0-9-]{1,39}$/;

/** Platforms the product intends to publish to, with no adapter in this installation yet. */
export const RESERVED_DESTINATION_IDS = ["youtube", "instagram", "tiktok"] as const;

export const RESERVED_DESTINATION_LABELS: Record<(typeof RESERVED_DESTINATION_IDS)[number], string> = {
  youtube: "YouTube",
  instagram: "Instagram",
  tiktok: "TikTok",
};

export const isDestinationIdShape = (value: unknown): value is DestinationId =>
  typeof value === "string" && DESTINATION_ID_PATTERN.test(value);

/** Shape only; whether a destination with this id exists is the registry's question. */
export const assertDestinationIdShape = (value: unknown): DestinationId => {
  if (!isDestinationIdShape(value)) {
    throw new TrackError(
      trackIssue(
        "PUBLISH_DESTINATION_UNKNOWN",
        `Unknown publishing destination ${JSON.stringify(value)}. Destination ids are lowercase words like "local-mock".`,
      ),
    );
  }
  return value;
};

/**
 * How a destination presents a publication. Generic on purpose: "video" is a
 * long-form upload, "short" a vertical short-form clip, "post" a feed post.
 * An adapter maps these onto its own platform vocabulary.
 */
export type PublicationMode = "video" | "short" | "post";

export const PUBLICATION_MODES: readonly PublicationMode[] = ["video", "short", "post"];

export type PublicationVisibility = "public" | "unlisted" | "private";

export const PUBLICATION_VISIBILITIES: readonly PublicationVisibility[] = ["public", "unlisted", "private"];

/** One format a destination accepts, and the mode it publishes that format as. */
export type DestinationFormatCapability = {
  readonly presetId: RenderPresetId;
  readonly mode: PublicationMode;
};

/** Destination-specific limits applied on top of the generic metadata rules. */
export type DestinationMetadataRules = {
  readonly titleMaxLength: number;
  readonly descriptionMaxLength: number;
  readonly maxTags: number;
  readonly tagMaxLength: number;
  readonly visibilities: readonly PublicationVisibility[];
};

export type DestinationCapabilities = {
  /** Every accepted format; a format not listed is format_unsupported. Never empty. */
  readonly formats: readonly DestinationFormatCapability[];
  readonly metadata: DestinationMetadataRules;
  /** Accepts a cover/thumbnail reference. */
  readonly thumbnail: boolean;
  /** Could honour scheduledAt. Data model only: nothing schedules in this milestone. */
  readonly scheduling: boolean;
  /** A publish in progress can be cancelled before it takes effect. */
  readonly cancel: boolean;
  /** Can answer, after an interruption, whether an attempt was published. */
  readonly recover: boolean;
  /**
   * The adapter itself proves that repeating an attempt with the same
   * idempotency key cannot create a second publication. False for any
   * platform that has not been shown to deduplicate; the engine never assumes it.
   */
  readonly idempotentPublish: boolean;
  /** Publishes as a named account/profile (the account id goes on the receipt). */
  readonly accounts: boolean;
  /** Talks to a network service. The mock destination does not. */
  readonly network: boolean;
};

/**
 * Whether a destination can publish from this machine right now.
 *
 * - ready:          implemented and configured
 * - unavailable:    no adapter in this installation, or a dependency is missing
 * - not_configured: implemented, but local configuration (an account,
 *                   credentials) is missing or invalid
 */
export type DestinationState = "ready" | "unavailable" | "not_configured";

/** What a host may show about a destination. Never carries secrets or paths. */
export type DestinationStatus = {
  readonly id: DestinationId;
  readonly displayName: string;
  readonly implemented: boolean;
  readonly state: DestinationState;
  readonly problem: string | null;
  /** The account/profile it would publish as, when configured; an identifier, never a credential. */
  readonly accountId: string | null;
  /** Null for a reserved destination with no adapter. */
  readonly capabilities: DestinationCapabilities | null;
};

export const formatCapability = (
  capabilities: DestinationCapabilities,
  presetId: RenderPresetId,
): DestinationFormatCapability | null =>
  capabilities.formats.find((entry) => entry.presetId === presetId) ?? null;
