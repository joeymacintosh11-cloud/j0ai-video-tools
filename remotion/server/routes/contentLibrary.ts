import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  ContentLibraryAdoptView,
  ContentLibraryRecordView,
  ContentLibraryReexportView,
  ContentLibraryView,
} from "../../core/domain/api/views.ts";
import {
  CONTENT_LIBRARY_RECORD_ID_PATTERN,
  CONTENT_LIBRARY_STATUS_NOTES,
  parseContentLibraryQuery,
} from "../../core/domain/library/contentLibrary.ts";
import { targetKey } from "../../core/domain/render/renderJournal.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertRenderPresetId } from "../../core/domain/video/renderPresets.ts";
import { storedRendererId, workflowEngineField } from "../../core/domain/video/renderers.ts";
import { adoptExistingExports } from "../../services/library/recordExport.ts";
import { inspectRenderTargetLock } from "../../services/render/renderLock.ts";
import { sendOk } from "../http/json.ts";
import {
  getContentLibraryRecord,
  queryContentLibrary,
} from "../../services/workflows/contentLibrary.ts";
import { renderManager } from "../../services/workflows/renderManager.ts";

/**
 * The content library over HTTP.
 *
 * Reads are read-only; the two writes are narrow. `reexport` starts a normal
 * one-target render batch through the existing render manager — the same
 * queue, lock, worker and publish every other render uses — and the new
 * export records itself when (and only if) it completes. `adopt` only ever
 * appends records for exports already on disk. No endpoint accepts a path.
 */

const assertRecordId = (value: string): string => {
  if (!CONTENT_LIBRARY_RECORD_ID_PATTERN.test(value)) {
    throw new TrackError(trackIssue("INVALID_REQUEST", `"${value}" is not a content library record id.`));
  }
  return value;
};

/** GET /api/content-library */
export const handleGetContentLibrary = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const { searchParams } = new URL(request.url ?? "/", "http://localhost");
  const filter = parseContentLibraryQuery({
    track: searchParams.get("track"),
    preset: searchParams.get("preset"),
    status: searchParams.get("status"),
    kind: searchParams.get("kind"),
    job: searchParams.get("job"),
    id: searchParams.get("id"),
    from: searchParams.get("from"),
    to: searchParams.get("to"),
    since: searchParams.get("since"),
    order: searchParams.get("order"),
    limit: searchParams.get("limit"),
  });

  const result = await queryContentLibrary({ filter });

  const payload: ContentLibraryView = {
    status: result.status,
    statusNote: CONTENT_LIBRARY_STATUS_NOTES[result.status],
    problems: result.problems,
    entries: result.entries,
    matched: result.matched,
    limit: filter.limit,
    summary: result.summary,
    knownTracks: result.knownTracks,
    knownPresets: result.knownPresets,
    formats: result.formats,
    deliveries: result.deliveries,
  };

  sendOk(response, payload);
};

/** GET /api/content-library/:recordId */
export const handleGetContentLibraryRecord = async (
  response: ServerResponse,
  recordId: string,
): Promise<void> => {
  const detail = await getContentLibraryRecord(assertRecordId(recordId));
  const payload: ContentLibraryRecordView = detail;
  sendOk(response, payload);
};

/**
 * POST /api/content-library/:recordId/reexport
 *
 * Refused unless the record is the version on disk now — see
 * `reexportEligibility` for why an older version cannot be re-exported. When
 * allowed, the new export's own record names this one as what it replaced,
 * because it is exactly what the publish will replace; the original record is
 * never touched.
 */
export const handleReexportContentLibraryRecord = async (
  response: ServerResponse,
  recordId: string,
): Promise<void> => {
  const detail = await getContentLibraryRecord(assertRecordId(recordId));

  if (!detail.reexport.allowed) {
    throw new TrackError(
      trackIssue("LIBRARY_RECORD_NOT_CURRENT", detail.reexport.reason ?? "This version cannot be re-exported."),
    );
  }

  const { record } = detail.entry;
  const alreadyActive = () =>
    new TrackError(
      trackIssue(
        "RENDER_ALREADY_ACTIVE",
        `${record.track.title} is already rendering ${record.preset.label}. Wait for it to finish, or cancel it first.`,
      ),
    );
  const lockedElsewhere = () =>
    new TrackError(
      trackIssue(
        "RENDER_TARGET_LOCKED",
        `${record.track.title} ${record.preset.label} is being rendered by another process. Wait for it to finish.`,
      ),
    );

  // Refused up front, so a refused re-export never leaves an empty batch
  // behind; startBatch's own skipped/locked report still covers the race.
  const presetId = assertRenderPresetId(record.preset.id);
  if (renderManager.inFlightTargets().has(targetKey(record.track.slug, presetId))) {
    throw alreadyActive();
  }
  if (inspectRenderTargetLock(record.track.slug, presetId).state !== "free") {
    throw lockedElsewhere();
  }

  // A re-export replaces this version's own file, so it renders with the
  // renderer that made it (eligibility refuses an unknown one), never the default.
  const engine = storedRendererId(record.template.renderer)!;
  const { batch, skipped, locked } = renderManager.startBatch([
    { slug: record.track.slug, preset: presetId, ...workflowEngineField(engine) },
  ]);

  if (skipped.length > 0) throw alreadyActive();
  if (locked.length > 0) throw lockedElsewhere();

  const payload: ContentLibraryReexportView = { recordId, batch };
  sendOk(response, payload);
};

/** POST /api/content-library/adopt */
export const handleAdoptExistingExports = async (response: ServerResponse): Promise<void> => {
  const payload: ContentLibraryAdoptView = await adoptExistingExports();
  sendOk(response, payload);
};
