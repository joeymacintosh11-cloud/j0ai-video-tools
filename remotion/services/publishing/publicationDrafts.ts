import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  parsePublicationDraftFields,
  publicationDraftProblems,
  PUBLICATION_DRAFT_ID_PATTERN,
  PUBLICATION_DRAFT_SCHEMA_VERSION,
  isDraftPlatform,
  isDraftStatus,
  statusAllowed,
  type DraftExportFacts,
  type PublicationDraft,
} from "../../core/domain/publishing/publicationDraft.ts";
import type { PublicationDraftView } from "../../core/domain/api/views.ts";
import type { PublishProblem } from "../../core/domain/publishing/publishProblems.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { isValidSlug } from "../../core/domain/tracks/slug.ts";
import { isRendererId } from "../../core/domain/video/renderers.ts";
import { isRenderPresetId } from "../../core/domain/video/renderPresets.ts";
import { withFileMutation, writeAtomicFile } from "../tracks/atomicFile.ts";
import { trackExportCoverage } from "../tracks/exportCoverage.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { publishingRoot } from "./publishingStore.ts";

/**
 * Publication drafts (core/domain/publishing/publicationDraft.ts), stored as
 *
 *   out/.publishing/drafts/<draftId>.json   one draft, rewritten atomically per save
 *
 * beside the publish jobs and receipts (publishingStore.ts), for the same
 * reasons: machine-local and apart from rendered content. A draft only
 * *refers* to an export (track, format, renderer); nothing here writes to an
 * export, its manifest, the content library, a delivery or a publish job.
 *
 * Every save names the revision it was edited from, so a stale form can never
 * overwrite a newer save. Saves are serialized per file within this process
 * (the API server is the only writer).
 */

const draftsDir = (root: string) => path.join(root, "drafts");

const assertDraftId = (draftId: string): string => {
  if (!PUBLICATION_DRAFT_ID_PATTERN.test(draftId))
    throw new TrackError(trackIssue("PUBLISH_DRAFT_NOT_FOUND", `Publication draft "${draftId}" not found.`));
  return draftId;
};

const draftPath = (draftId: string, root: string) => path.join(draftsDir(root), `${assertDraftId(draftId)}.json`);

export const newPublicationDraftId = (): string => `drf_${randomBytes(12).toString("hex")}`;

const isStoredDraft = (value: unknown): value is PublicationDraft => {
  const v = value as PublicationDraft | null;
  return (
    v !== null &&
    typeof v === "object" &&
    v.schemaVersion === PUBLICATION_DRAFT_SCHEMA_VERSION &&
    PUBLICATION_DRAFT_ID_PATTERN.test(v.draftId) &&
    Number.isInteger(v.revision) &&
    v.revision >= 1 &&
    isDraftPlatform(v.platform) &&
    isDraftStatus(v.status) &&
    typeof v.source === "object" &&
    v.source !== null &&
    isValidSlug(v.source.track) &&
    isRenderPresetId(v.source.format) &&
    isRendererId(v.source.renderer) &&
    typeof v.title === "string" &&
    typeof v.description === "string" &&
    Array.isArray(v.hashtags) &&
    v.hashtags.every((tag) => typeof tag === "string")
  );
};

const readDraftFile = (draftId: string, root: string): PublicationDraft => {
  let text: string;
  try {
    text = readFileSync(draftPath(draftId, root), "utf8");
  } catch {
    throw new TrackError(trackIssue("PUBLISH_DRAFT_NOT_FOUND", `Publication draft "${draftId}" not found.`));
  }
  let value: unknown = null;
  try {
    value = JSON.parse(text);
  } catch {
    // Reported below.
  }
  if (!isStoredDraft(value) || value.draftId !== draftId)
    throw new Error(`Publication draft file for "${draftId}" is unreadable or invalid; it is left untouched for inspection.`);
  return value;
};

const writeDraftFile = async (draft: PublicationDraft, root: string): Promise<void> => {
  await mkdir(draftsDir(root), { recursive: true });
  const file = draftPath(draft.draftId, root);
  await writeAtomicFile(file, (handle) => handle.writeFile(`${JSON.stringify(draft, null, 2)}\n`, "utf8"));
};

/** The export a draft points at, judged by that renderer's own coverage. */
const exportFactsFor = async (
  draft: Pick<PublicationDraft, "source">,
): Promise<DraftExportFacts & { readonly label: string; readonly trackExists: boolean }> => {
  const { track, format, renderer } = draft.source;
  const inspection = await inspectTrack(track);
  if (!inspection.facts.trackDirExists || inspection.metadata === null)
    return { trackValid: false, trackExists: inspection.facts.trackDirExists, freshness: "invalid", label: format };
  const facts = trackExportCoverage(track, inspection.metadata, renderer).find((entry) => entry.presetId === format);
  return { trackValid: true, trackExists: true, freshness: facts?.freshness ?? "missing", label: facts?.label ?? format };
};

export type PublicationDraftState = PublicationDraftView;

const stateOf = async (draft: PublicationDraft): Promise<PublicationDraftState> => {
  const facts = await exportFactsFor(draft);
  return {
    draft,
    export: { freshness: facts.freshness, label: facts.label, trackValid: facts.trackValid },
    problems: publicationDraftProblems(draft, facts),
  };
};

const refuse = (problems: readonly PublishProblem[], prefix: string): never => {
  throw new TrackError(trackIssue("PUBLISH_DRAFT_INVALID", `${prefix} ${problems.map((problem) => problem.message).join(" ")}`));
};

/** Parses the fields, checks the track exists, and refuses ready/posted while anything is wrong. */
const checkedFields = async (raw: unknown) => {
  const parsed = parsePublicationDraftFields(raw);
  if (parsed.fields === null) return refuse(parsed.problems, "This draft cannot be saved:");
  const fields = parsed.fields;
  if (!isValidSlug(fields.source.track))
    throw new TrackError(trackIssue("TRACK_NOT_FOUND", `Track "${fields.source.track}" not found.`));
  const facts = await exportFactsFor(fields);
  if (!facts.trackExists) throw new TrackError(trackIssue("TRACK_NOT_FOUND", `Track "${fields.source.track}" not found.`));
  const problems = publicationDraftProblems(fields, facts);
  if (!statusAllowed(fields.status, problems))
    refuse(problems, `A draft can only be marked "${fields.status}" once nothing is wrong with it:`);
  return fields;
};

export type ListPublicationDraftsResult = {
  readonly drafts: readonly PublicationDraftState[];
  /** Draft files that could not be read; left on disk untouched. */
  readonly problems: readonly { readonly file: string; readonly message: string }[];
};

export const listPublicationDrafts = async (
  filter: { readonly track?: string } = {},
  root: string = publishingRoot(),
): Promise<ListPublicationDraftsResult> => {
  let names: string[];
  try {
    names = readdirSync(draftsDir(root)).filter((name) => /^drf_[a-f0-9]{24}\.json$/.test(name));
  } catch {
    return { drafts: [], problems: [] };
  }
  const drafts: PublicationDraft[] = [];
  const problems: { file: string; message: string }[] = [];
  for (const name of names) {
    try {
      drafts.push(readDraftFile(name.slice(0, -".json".length), root));
    } catch (error) {
      problems.push({ file: `drafts/${name}`, message: error instanceof Error ? error.message : String(error) });
    }
  }
  const selected = drafts
    .filter((draft) => filter.track === undefined || draft.source.track === filter.track)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.draftId.localeCompare(b.draftId));
  return { drafts: await Promise.all(selected.map(stateOf)), problems };
};

export const getPublicationDraft = async (draftId: string, root: string = publishingRoot()): Promise<PublicationDraftState> =>
  stateOf(readDraftFile(draftId, root));

export const createPublicationDraft = async (
  raw: unknown,
  { root = publishingRoot(), now = () => new Date() }: { readonly root?: string; readonly now?: () => Date } = {},
): Promise<PublicationDraftState> => {
  const fields = await checkedFields(raw);
  const at = now().toISOString();
  const draft: PublicationDraft = {
    schemaVersion: PUBLICATION_DRAFT_SCHEMA_VERSION,
    draftId: newPublicationDraftId(),
    createdAt: at,
    updatedAt: at,
    revision: 1,
    ...fields,
  };
  await writeDraftFile(draft, root);
  return stateOf(draft);
};

/**
 * Replaces a draft's editable fields. `revision` must be the revision the
 * edit was made from; a newer save in between is a conflict, never overwritten.
 */
export const updatePublicationDraft = async (
  draftId: string,
  raw: unknown,
  { root = publishingRoot(), now = () => new Date() }: { readonly root?: string; readonly now?: () => Date } = {},
): Promise<PublicationDraftState> => {
  const file = draftPath(draftId, root);
  const expected = (raw as { revision?: unknown } | null)?.revision;
  if (!Number.isInteger(expected))
    throw new TrackError(trackIssue("INVALID_REQUEST", 'Provide "revision": the draft revision this edit was made from.'));
  return withFileMutation(file, async () => {
    const current = readDraftFile(draftId, root);
    if (current.revision !== expected)
      throw new TrackError(
        trackIssue(
          "PUBLISH_DRAFT_CONFLICT",
          `This draft was saved elsewhere (revision ${current.revision}, edited from ${String(expected)}). Reload it before saving again.`,
        ),
      );
    const fields = await checkedFields(raw);
    const next: PublicationDraft = {
      ...current,
      ...fields,
      revision: current.revision + 1,
      updatedAt: now().toISOString(),
    };
    await writeDraftFile(next, root);
    return stateOf(next);
  });
};
