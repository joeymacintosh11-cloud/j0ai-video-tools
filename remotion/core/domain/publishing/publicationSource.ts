import type { ContentPackageView } from "../content/contentPackage.ts";
import { PLATFORM_PROFILES, type PlatformId } from "../content/platformProfiles.ts";
import { TrackError, trackIssue } from "../tracks/errors.ts";
import { assertValidSlug, isValidSlug } from "../tracks/slug.ts";
import { assertRenderPresetId, isRenderPresetId, type RenderPresetId } from "../video/renderPresets.ts";
import {
  DEFAULT_RENDERER_ID,
  isRendererId,
  RENDERER_IDS,
  type RendererId,
} from "../video/renderers.ts";

/**
 * What a publish job publishes: one existing export, named exactly.
 *
 * Publishing consumes a small normalised source rather than an export record
 * or a content-package entry directly. The *reference* names a track, a
 * format and the renderer whose export is meant — all three explicit, so an
 * After Effects export can never be answered with the Remotion export of the
 * same track and format, or the other way round. The *identity* is what the
 * engine pins once it has found that export on disk: the manifest's input
 * fingerprint, its render time and the file's identity. A job publishes that
 * identity or nothing; if the file is replaced, the job refuses to continue.
 *
 * A content package is one way to arrive at a reference
 * (publicationSourceFromPackage), not a dependency: platform APIs never see a
 * package, and packages are unchanged by publishing.
 */

export type PublicationSourceRef = {
  readonly slug: string;
  readonly presetId: RenderPresetId;
  /** Required: publishing never infers which renderer's export is meant. */
  readonly renderer: RendererId;
};

/** The pinned export: enough to recognise the exact file again, and nothing machine-specific. */
export type PublicationSourceIdentity = PublicationSourceRef & {
  /** The export manifest's inputFingerprint. */
  readonly inputFingerprint: string;
  /** The export manifest's renderedAt. */
  readonly renderedAt: string;
  readonly output: { readonly bytes: number; readonly mtimeMs: number; readonly ino: number };
  /** Project-relative, for display (out/<slug>[/<renderer>]/<preset>.mp4). */
  readonly outputLabel: string;
};

export const sameSourceRef = (a: PublicationSourceRef, b: PublicationSourceRef): boolean =>
  a.slug === b.slug && a.presetId === b.presetId && a.renderer === b.renderer;

/** Exact export identity: same reference, same manifest, same file. */
export const sameSourceIdentity = (a: PublicationSourceIdentity, b: PublicationSourceIdentity): boolean =>
  sameSourceRef(a, b) &&
  a.inputFingerprint === b.inputFingerprint &&
  a.renderedAt === b.renderedAt &&
  a.output.bytes === b.output.bytes &&
  a.output.mtimeMs === b.output.mtimeMs &&
  a.output.ino === b.output.ino;

const requestError = (message: string): never => {
  throw new TrackError(trackIssue("INVALID_REQUEST", message));
};

/**
 * Reads a source reference from untrusted input ({ track, format, renderer }).
 * The renderer is mandatory here, unlike render requests: there is no default
 * export to publish.
 */
export const parsePublicationSourceRef = (raw: unknown): PublicationSourceRef => {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return requestError('Provide source: { "track": <slug>, "format": <preset id>, "renderer": <renderer id> }.');
  const value = raw as Record<string, unknown>;
  const slug = assertValidSlug(value.track);
  const presetId = assertRenderPresetId(value.format);
  if (value.renderer === undefined || value.renderer === null || value.renderer === "")
    return requestError(`source.renderer is required: name the renderer whose export to publish (${RENDERER_IDS.join(", ")}).`);
  if (!isRendererId(value.renderer))
    throw new TrackError(trackIssue("INVALID_RENDERER", `Unknown renderer ${JSON.stringify(value.renderer)}. Expected one of: ${RENDERER_IDS.join(", ")}.`));
  return { slug, presetId, renderer: value.renderer };
};

/** Strict structural check for a stored identity (job files, receipts). */
export const isPublicationSourceIdentity = (value: unknown): value is PublicationSourceIdentity => {
  const v = value as PublicationSourceIdentity | null;
  return (
    v !== null &&
    typeof v === "object" &&
    isValidSlug(v.slug) &&
    isRenderPresetId(v.presetId) &&
    isRendererId(v.renderer) &&
    typeof v.inputFingerprint === "string" &&
    /^[a-f0-9]{64}$/.test(v.inputFingerprint) &&
    typeof v.renderedAt === "string" &&
    Number.isFinite(Date.parse(v.renderedAt)) &&
    typeof v.output === "object" &&
    v.output !== null &&
    Number.isFinite(v.output.bytes) &&
    v.output.bytes > 0 &&
    Number.isFinite(v.output.mtimeMs) &&
    Number.isFinite(v.output.ino) &&
    typeof v.outputLabel === "string"
  );
};

/**
 * A source reference for one platform of a derived content package. The
 * package's renderer is the renderer its export facts came from (absent means
 * Remotion), so the reference names exactly the export the package showed.
 * Refuses a platform the package does not hold a ready export for.
 */
export const publicationSourceFromPackage = (
  view: Pick<ContentPackageView, "slug" | "renderer" | "platforms">,
  platformId: PlatformId,
): PublicationSourceRef => {
  const entry = view.platforms.find((platform) => platform.platformId === platformId);
  if (entry === undefined || !entry.selected)
    return requestError(`${PLATFORM_PROFILES[platformId].label} is not part of this content package.`);
  if (entry.readiness !== "ready")
    return requestError(`${entry.label} has no current export to publish (${entry.readiness}).`);
  return { slug: view.slug, presetId: entry.presetId, renderer: view.renderer ?? DEFAULT_RENDERER_ID };
};
