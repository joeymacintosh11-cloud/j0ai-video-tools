import type { IncomingMessage, ServerResponse } from "node:http";
import type { RenderHistoryJobView, RenderHistoryView } from "../../core/domain/api/views.ts";
import {
  RENDER_HISTORY_DEFAULT_LIMIT,
  RENDER_HISTORY_MAX_LIMIT,
  RENDER_JOURNAL_STATUS_NOTES,
} from "../../core/domain/render/renderJournal.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import { sendOk } from "../http/json.ts";
import { renderManager } from "../services/renderManager.ts";
import { getRecentRenderHistory } from "../services/renderJournal.ts";

/**
 * Read-only, journal-backed answer to "what happened to this track's most
 * recent renders?" — the operator-facing surface over the durable render
 * journal (core/domain/render/renderJournal.ts). Never a second readiness or
 * queue authority: this endpoint only ever reports what the journal already
 * recorded, grouped by job, newest first. It does not accept a job id (that
 * is `GET /api/renders/:id`) and it never mutates the journal.
 */

const invalid = (message: string): never => {
  throw new TrackError(trackIssue("INVALID_REQUEST", message));
};

const readLimit = (value: string | null): number => {
  if (value === null) return RENDER_HISTORY_DEFAULT_LIMIT;

  const limit = Number(value);

  if (!Number.isInteger(limit) || limit < 1 || limit > RENDER_HISTORY_MAX_LIMIT) {
    return invalid(
      `"limit" must be a whole number between 1 and ${RENDER_HISTORY_MAX_LIMIT}.`,
    );
  }

  return limit;
};

export const handleGetRenderHistory = (
  request: IncomingMessage,
  response: ServerResponse,
): void => {
  const { searchParams } = new URL(request.url ?? "/", "http://localhost");

  const trackParam = searchParams.get("track");
  if (trackParam === null || trackParam.trim().length === 0) {
    invalid('"track" is required.');
  }
  const slug = assertValidSlug(trackParam);
  const limit = readLimit(searchParams.get("limit"));

  // Live authority always wins (mirrors getJobOrHistorical in
  // server/routes/renders.ts, applied here at the list level): a job
  // renderManager currently holds live for this track must never be
  // reported through this journal-only endpoint, where it would be
  // misclassified "interrupted" for having no live owner *the journal can
  // see*. It belongs in the live render state this page shows elsewhere.
  const liveJobIds = new Set(
    renderManager
      .listJobs()
      .filter((job) => job.slug === slug)
      .map((job) => job.id),
  );

  const result = getRecentRenderHistory(slug, limit, liveJobIds);

  const jobs: readonly RenderHistoryJobView[] = result.jobs.map((job) => ({
    jobId: job.jobId,
    slug: job.slug,
    // classifyRecoveredJob never returns queued/preparing/rendering — see
    // its own comment in core/domain/render/renderJournal.ts.
    presetId: job.presetId as RenderHistoryJobView["presetId"],
    status: job.status as RenderHistoryJobView["status"],
    recordedAt: job.recordedAt,
    historical: true,
    recoveredAfterRestart: job.recoveredAfterRestart,
    error: job.error as RenderHistoryJobView["error"],
  }));

  const payload: RenderHistoryView = {
    slug,
    status: result.status,
    statusNote: RENDER_JOURNAL_STATUS_NOTES[result.status],
    jobs,
    limit,
  };

  sendOk(response, payload);
};
