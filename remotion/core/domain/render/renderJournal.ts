/**
 * The durable render-lifecycle journal: what happened, not what should happen.
 *
 * This answers "what did the render manager last know about this job?" across
 * an API-server restart. It never decides what runs next — that stays with
 * `renderManager`, the worker process, the render queue and the render lock,
 * exactly as before this existed. See services/render/renderJournalLog.ts for
 * the file it is read from, and server/services/renderJournal.ts for how the
 * server turns reconstructed history into a query answer.
 *
 * Pure and browser-safe, mirroring core/domain/delivery/deliveryHistory.ts:
 * the event shape, parsing and reconstruction rules live in one place so the
 * server and its tests agree on them without any I/O.
 *
 * **Why events, not a rewritten snapshot.** A job's lifecycle is a handful of
 * low-frequency transitions (queued, preparing, rendering once, one terminal
 * state) — appending each is a single write with nothing to read first, so a
 * crash can damage at most the final line, exactly like the delivery log. A
 * mutable per-job record would mean rewriting a shared file on every
 * transition, which reintroduces the lost-update and partial-write problems
 * the delivery log's own comment explains at length.
 */

export const RENDER_JOURNAL_SCHEMA_VERSION = 1;
export const RENDER_JOURNAL_FILENAME = "journal.jsonl";

/**
 * States the render manager itself has actually observed and written.
 *
 * `interrupted` is deliberately not one of them — nothing ever *records*
 * interrupted, because nothing ever observes it happening. It is inferred at
 * read time (see `classifyRecoveredJob` below) when reconstruction finds a
 * job whose last written state is non-terminal and whose boot id does not
 * match the process asking. Keeping it out of the written vocabulary means
 * every event in the file describes a real, witnessed transition.
 */
export type RenderJournalLifecycleState =
  | "queued"
  | "preparing"
  | "rendering"
  | "completed"
  | "failed"
  | "cancelled";

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "queued",
  "preparing",
  "rendering",
  "completed",
  "failed",
  "cancelled",
]);

export const isTerminalJournalState = (
  state: RenderJournalLifecycleState,
): boolean => state === "completed" || state === "failed" || state === "cancelled";

/**
 * One narrow lifecycle fact.
 *
 * `batchId` is the only correlation carried: it is the one grouping the
 * render manager itself already knows. Content-Package batch/action/platform
 * correlation is a layer above the render manager (see
 * server/routes/contentPackageBatch.ts's `jobReferences`) and is deliberately
 * not threaded down into this — doing so would mean widening
 * `RenderManager.startBatch`'s public shape for every caller (the
 * destination-fix planner, export-missing, the CLI) to carry a field only one
 * caller would ever fill in. The journal answers "what happened to job X",
 * which needs none of that; a caller that already knows an action's exact
 * job id can still ask this journal about it by id.
 *
 * No paths, no titles, no metadata: exactly what distinguishes one lifecycle
 * fact from the next and nothing a track's content ever supplies.
 */
export type RenderJournalEvent = {
  readonly schemaVersion: number;
  /** Unique per appended event; makes a retried append idempotent. */
  readonly eventId: string;
  readonly jobId: string;
  readonly batchId: string | null;
  readonly slug: string;
  readonly presetId: string;
  readonly state: RenderJournalLifecycleState;
  readonly recordedAt: string;
  /**
   * Identifies the process that observed this transition.
   *
   * A fresh id is created once per process start (server boot, or a one-shot
   * CLI invocation that renders directly). Comparing a job's last recorded
   * boot id against the *current* process's own is the entire mechanism that
   * turns "last seen rendering" into "interrupted": a match means this
   * process is still the one that owns the job (and would have it live in
   * memory if it really were still running); a mismatch means whatever
   * process wrote that event is not this one, so nothing here can still be
   * executing it.
   */
  readonly bootId: string;
  readonly error: { readonly code: string; readonly message: string } | null;
};

const MAX_LINE_LENGTH = 8_192;

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

export type RenderJournalProblemKind =
  | "malformed"
  | "unsupported"
  | "truncated"
  | "duplicate"
  | "illegal_transition"
  | "oversized";

export type RenderJournalProblem = {
  readonly line: number;
  readonly kind: RenderJournalProblemKind;
  readonly message: string;
};

export type RenderJournalStatus =
  | "missing"
  | "complete"
  | "recovered_tail"
  | "unsupported"
  | "duplicated"
  | "corrupt";

export type RenderJournalRead = {
  readonly status: RenderJournalStatus;
  readonly events: readonly RenderJournalEvent[];
  readonly problems: readonly RenderJournalProblem[];
  readonly lines: number;
  readonly endsWithNewline: boolean;
};

export type ParsedRenderJournalLine =
  | { readonly ok: true; readonly event: RenderJournalEvent }
  | {
      readonly ok: false;
      readonly kind: Exclude<RenderJournalProblemKind, "truncated" | "duplicate" | "illegal_transition">;
      readonly message: string;
    };

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

/** One line of the journal, validated. A newer schema is reported, not rejected as damage. */
export const parseRenderJournalLine = (line: string): ParsedRenderJournalLine => {
  if (line.length > MAX_LINE_LENGTH) {
    return {
      ok: false,
      kind: "oversized",
      message: `line is ${line.length} bytes, over the ${MAX_LINE_LENGTH}-byte bound`,
    };
  }

  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return { ok: false, kind: "malformed", message: "not valid JSON" };
  }

  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, kind: "malformed", message: "not a JSON object" };
  }

  const event = value as Partial<RenderJournalEvent>;

  if (!Number.isInteger(event.schemaVersion) || (event.schemaVersion ?? 0) < 1) {
    return { ok: false, kind: "malformed", message: "no usable schemaVersion" };
  }
  if ((event.schemaVersion as number) > RENDER_JOURNAL_SCHEMA_VERSION) {
    return {
      ok: false,
      kind: "unsupported",
      message:
        `schemaVersion ${event.schemaVersion} was written by a newer version of ` +
        `this tool (this one reads ${RENDER_JOURNAL_SCHEMA_VERSION})`,
    };
  }

  const timestamp = typeof event.recordedAt === "string" ? Date.parse(event.recordedAt) : NaN;
  const error = event.error;
  const validError =
    error === null ||
    error === undefined ||
    (typeof error === "object" &&
      isNonEmptyString((error as { code?: unknown }).code) &&
      typeof (error as { message?: unknown }).message === "string");

  if (
    !isNonEmptyString(event.eventId) ||
    !isNonEmptyString(event.jobId) ||
    !isNonEmptyString(event.slug) ||
    !isNonEmptyString(event.presetId) ||
    !isNonEmptyString(event.bootId) ||
    typeof event.state !== "string" ||
    !KNOWN_STATES.has(event.state) ||
    (event.batchId !== null && typeof event.batchId !== "string") ||
    Number.isNaN(timestamp) ||
    !validError
  ) {
    return { ok: false, kind: "malformed", message: "not a well-formed render journal event" };
  }

  return {
    ok: true,
    event: {
      schemaVersion: event.schemaVersion as number,
      eventId: event.eventId,
      jobId: event.jobId,
      batchId: event.batchId ?? null,
      slug: event.slug,
      presetId: event.presetId,
      state: event.state as RenderJournalLifecycleState,
      recordedAt: event.recordedAt as string,
      bootId: event.bootId,
      error: (error ?? null) as RenderJournalEvent["error"],
    },
  };
};

/**
 * Parses the whole journal from its text.
 *
 * Ordering is the order lines appear in the file. That is deliberate rather
 * than an oversight (see §11 of the milestone brief this implements): the
 * append lock in services/render/renderJournalLog.ts guarantees a write lands
 * as one complete line before the next append begins, so file order already
 * *is* the true global order events happened in. Re-deriving order from
 * `recordedAt` would be strictly weaker — wall-clock time is not guaranteed
 * monotonic across two processes on the same host — and would add a field
 * this reader does not need.
 */
export const parseRenderJournal = (text: string): RenderJournalRead => {
  const events: RenderJournalEvent[] = [];
  const problems: RenderJournalProblem[] = [];
  const endsWithNewline = text.length === 0 || text.endsWith("\n");
  const rows = text.split("\n");
  if (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();

  rows.forEach((row, index) => {
    const lineNumber = index + 1;
    const isFinal = index === rows.length - 1;

    if (row.trim().length === 0) return;

    const parsed = parseRenderJournalLine(row);
    if (parsed.ok) {
      events.push(parsed.event);
      return;
    }

    problems.push({
      line: lineNumber,
      kind:
        isFinal && !endsWithNewline && parsed.kind === "malformed" ? "truncated" : parsed.kind,
      message: parsed.message,
    });
  });

  // A genuine duplicate eventId means a retried append (harmless) or the file
  // was edited/merged by something else. Either way it is worth surfacing —
  // never silently dropped, never treated as damage on its own.
  const seen = new Set<string>();
  events.forEach((event, index) => {
    if (seen.has(event.eventId)) {
      problems.push({
        line: index + 1,
        kind: "duplicate",
        message: `event ${index + 1} repeats eventId ${event.eventId}`,
      });
    }
    seen.add(event.eventId);
  });

  const status: RenderJournalStatus = problems.some((p) => p.kind === "malformed" || p.kind === "oversized")
    ? "corrupt"
    : problems.some((p) => p.kind === "unsupported")
      ? "unsupported"
      : problems.some((p) => p.kind === "truncated")
        ? "recovered_tail"
        : problems.some((p) => p.kind === "duplicate")
          ? "duplicated"
          : "complete";

  return { status, events, problems, lines: rows.length, endsWithNewline };
};

export const isSeriousJournalDamage = (status: RenderJournalStatus): boolean =>
  status === "corrupt" || status === "unsupported";

/* ------------------------------------------------------------------ *
 * Reconstruction
 * ------------------------------------------------------------------ */

/**
 * Legal successor states.
 *
 * A terminal state's set is empty: once written, nothing may follow it. This
 * is what "terminal immutability" (§38 of the brief) means mechanically — a
 * later event that names a terminal job is quarantined rather than applied,
 * however it got there.
 *
 * A job's very *first* observed event is not checked against this table
 * (there is no predecessor yet): tail repair or an unrelated corrupt line
 * earlier in the file could legitimately mean this job's own `queued` event
 * is simply not present any more, and reconstruction's job is to recover as
 * much true history as still exists, not to refuse a job because its origin
 * is missing.
 */
const LEGAL_SUCCESSORS: Readonly<Record<RenderJournalLifecycleState, ReadonlySet<RenderJournalLifecycleState>>> = {
  queued: new Set(["preparing", "cancelled", "failed"]),
  preparing: new Set(["rendering", "completed", "cancelled", "failed"]),
  rendering: new Set(["completed", "cancelled", "failed"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export type RenderJournalJobRecord = {
  readonly jobId: string;
  readonly slug: string;
  readonly presetId: string;
  readonly batchId: string | null;
  readonly state: RenderJournalLifecycleState;
  readonly recordedAt: string;
  readonly bootId: string;
  readonly error: RenderJournalEvent["error"];
};

export type RenderJournalReconstruction = {
  readonly jobs: ReadonlyMap<string, RenderJournalJobRecord>;
  /** Events that could not be applied: duplicates and illegal transitions. */
  readonly quarantined: readonly { readonly event: RenderJournalEvent; readonly reason: string }[];
  /**
   * File-order index of the event that most recently produced each job's
   * current record. Not `recordedAt`: wall-clock time is not guaranteed
   * monotonic across two processes' boot ids, but file order already is the
   * true global order events happened in (the same reasoning
   * `parseRenderJournal`'s own comment gives for using it as event order in
   * the first place). This is what lets a caller sort several jobs of one
   * track "most recently active first" without trusting timestamps alone.
   */
  readonly order: ReadonlyMap<string, number>;
};

/**
 * Folds parsed events into the latest legal state per job.
 *
 * A duplicate (repeated eventId, or a same-state repeat of the current
 * record) is silently idempotent — exactly the replay a retried append
 * produces. An event naming a state that is not a legal successor of the
 * job's current state is quarantined: the record is left exactly as it was,
 * and the event is reported rather than guessed into place. This is the one
 * place "conflicting terminal states" (§39) becomes visible rather than
 * silently picking a winner.
 */
export const reconstructRenderJournal = (
  events: readonly RenderJournalEvent[],
): RenderJournalReconstruction => {
  const jobs = new Map<string, RenderJournalJobRecord>();
  const order = new Map<string, number>();
  const seenEventIds = new Set<string>();
  const quarantined: { readonly event: RenderJournalEvent; readonly reason: string }[] = [];

  events.forEach((event, index) => {
    if (seenEventIds.has(event.eventId)) return;
    seenEventIds.add(event.eventId);

    const existing = jobs.get(event.jobId);

    if (!existing) {
      jobs.set(event.jobId, {
        jobId: event.jobId,
        slug: event.slug,
        presetId: event.presetId,
        batchId: event.batchId,
        state: event.state,
        recordedAt: event.recordedAt,
        bootId: event.bootId,
        error: event.error,
      });
      order.set(event.jobId, index);
      return;
    }

    if (event.state === existing.state) {
      // Idempotent repeat of the current state; refresh the timestamp/boot
      // only if this event is not itself a stale replay (best-effort — file
      // order already makes this the newer of the two).
      jobs.set(event.jobId, {
        ...existing,
        recordedAt: event.recordedAt,
        bootId: event.bootId,
        error: event.error ?? existing.error,
      });
      order.set(event.jobId, index);
      return;
    }

    if (!LEGAL_SUCCESSORS[existing.state].has(event.state)) {
      quarantined.push({
        event,
        reason: `job ${event.jobId} cannot move from "${existing.state}" to "${event.state}"`,
      });
      return;
    }

    jobs.set(event.jobId, {
      jobId: event.jobId,
      slug: event.slug,
      presetId: event.presetId,
      batchId: event.batchId,
      state: event.state,
      recordedAt: event.recordedAt,
      bootId: event.bootId,
      error: event.error,
    });
    order.set(event.jobId, index);
  });

  return { jobs, quarantined, order };
};

/* ------------------------------------------------------------------ *
 * Recovery classification
 * ------------------------------------------------------------------ */

/**
 * What a client may be told about a job the live render manager no longer has.
 *
 * `status` reuses the job's real terminal state when it has one; a
 * non-terminal record from a different boot becomes `"interrupted"` — never
 * `"queued"`/`"preparing"`/`"rendering"`, which would look like a live job
 * still doing something, and never `"cancelled"`, which would fabricate a
 * cancellation nobody requested (§5 of the brief this implements).
 *
 * `recoveredAfterRestart` distinguishes two honestly different situations
 * that both reach here: a genuine restart (the record's boot id differs from
 * the asking process's own), and a same-process job the render manager has
 * simply trimmed from its bounded in-memory history after settling. Both are
 * "no longer live", but only the first is actually a restart.
 */
export type RecoveredRenderJob = {
  readonly jobId: string;
  readonly slug: string;
  readonly presetId: string;
  readonly batchId: string | null;
  readonly status: RenderJournalLifecycleState | "interrupted";
  readonly recordedAt: string;
  readonly error: RenderJournalEvent["error"];
  readonly recoveredAfterRestart: boolean;
};

export const classifyRecoveredJob = (
  record: RenderJournalJobRecord,
  currentBootId: string,
): RecoveredRenderJob => {
  const recoveredAfterRestart = record.bootId !== currentBootId;

  return {
    jobId: record.jobId,
    slug: record.slug,
    presetId: record.presetId,
    batchId: record.batchId,
    status: isTerminalJournalState(record.state)
      ? record.state
      : recoveredAfterRestart
        ? "interrupted"
        // Non-terminal, same boot, yet not live: an anomaly (a manually
        // edited journal, say) rather than a real restart. Still not safe to
        // report as actively queued/preparing/rendering, since nothing here
        // owns it — "interrupted" is the honest answer either way.
        : "interrupted",
    recordedAt: record.recordedAt,
    error: record.error,
    recoveredAfterRestart,
  };
};

/* ------------------------------------------------------------------ *
 * Retention
 * ------------------------------------------------------------------ */

export const RENDER_JOURNAL_RETENTION_DAYS = 30;
export const RENDER_JOURNAL_MAX_TERMINAL_JOBS = 1000;

/**
 * Which jobs a compaction should keep, and how much of their history.
 *
 * Non-terminal jobs are never dropped, however old — they are exactly the
 * "current non-terminal recovery evidence" §33 says must never be silently
 * removed, and a job that looks non-terminal only because its terminal event
 * was itself corrupted is safer kept than lost. For a terminal job, only the
 * latest event carries any information a reader still needs (the earlier
 * queued/preparing/rendering events are superseded), so compaction keeps at
 * most one line per terminal job, and only for the most recent
 * `RENDER_JOURNAL_MAX_TERMINAL_JOBS` of them within
 * `RENDER_JOURNAL_RETENTION_DAYS` days.
 */
export const selectRetainedEvents = (
  events: readonly RenderJournalEvent[],
  now: Date = new Date(),
  retentionDays: number = RENDER_JOURNAL_RETENTION_DAYS,
  maxTerminalJobs: number = RENDER_JOURNAL_MAX_TERMINAL_JOBS,
): readonly RenderJournalEvent[] => {
  const { jobs } = reconstructRenderJournal(events);
  const cutoff = now.getTime() - retentionDays * 24 * 60 * 60 * 1000;

  const nonTerminal = [...jobs.values()].filter((job) => !isTerminalJournalState(job.state));
  const terminal = [...jobs.values()]
    .filter((job) => isTerminalJournalState(job.state))
    .filter((job) => Date.parse(job.recordedAt) >= cutoff)
    .sort((a, b) => Date.parse(b.recordedAt) - Date.parse(a.recordedAt))
    .slice(0, maxTerminalJobs);

  const retainedJobIds = new Set([...nonTerminal, ...terminal].map((job) => job.jobId));

  // Non-terminal *jobs* keep every event (their full history is small and is
  // exactly the audit trail a still-open job's recovery might want); terminal
  // *jobs* keep only the one event reconstruction actually accepted as their
  // terminal state. Note this is decided per job, not per event: a completed
  // job's own earlier queued/preparing/rendering events are individually
  // non-terminal, but they belong to a job whose final state is terminal, so
  // they are superseded too and must not survive compaction just because the
  // event itself isn't the terminal one.
  //
  // The kept terminal event is deliberately not "the last terminal-state line
  // in the file" — a job with an illegal second terminal event (quarantined
  // by reconstruction above) would otherwise have compaction keep the wrong,
  // rejected one and silently overwrite the audit record with it. Terminal
  // state is assigned at most once per job, so the *first* event matching the
  // reconstructed (jobId, state) pair is always the accepted one.
  const keptEventIdByJob = new Map<string, string>();
  for (const event of events) {
    if (!isTerminalJournalState(event.state) || !retainedJobIds.has(event.jobId)) continue;
    if (keptEventIdByJob.has(event.jobId)) continue;
    if (jobs.get(event.jobId)?.state !== event.state) continue;
    keptEventIdByJob.set(event.jobId, event.eventId);
  }

  return events.filter((event) => {
    if (!retainedJobIds.has(event.jobId)) return false;
    const finalState = jobs.get(event.jobId)?.state;
    if (finalState === undefined || !isTerminalJournalState(finalState)) return true;
    return keptEventIdByJob.get(event.jobId) === event.eventId;
  });
};

/* ------------------------------------------------------------------ *
 * Operator-facing recent history (one track, grouped by job)
 * ------------------------------------------------------------------ */

/** A note for the user about a journal read status, when there is anything to say. Mirrors DELIVERY_LOG_STATUS_NOTES's own vocabulary and tone. */
export const RENDER_JOURNAL_STATUS_NOTES: Record<RenderJournalStatus, string | null> = {
  missing: null,
  complete: null,
  duplicated:
    "The render journal contains an event more than once. Nothing this tool " +
    "does produces a repeat, so the file has been edited or appended to by " +
    "something else. Every event was read and nothing has been changed.",
  recovered_tail:
    "The last line of the render journal is incomplete, which is what an " +
    "interrupted append leaves behind. Every event before it was read.",
  unsupported:
    "Part of the render journal was written by a newer version of this " +
    "tool and could not be read. Earlier history is still shown.",
  corrupt:
    "The render journal is damaged, so some history may be missing. What " +
    "could be read is still shown.",
};

export const RENDER_HISTORY_DEFAULT_LIMIT = 3;
export const RENDER_HISTORY_MAX_LIMIT = 10;

/**
 * The most recent renders of one track, newest first — one entry per job (its
 * final reconstructed state), never one entry per lifecycle event (§8/§9 of
 * the milestone this implements: an operator asks "what happened to this
 * track's renders", not "show me every transition").
 *
 * Ordered by `reconstruction.order` (file position), not `recordedAt` — see
 * that field's own comment for why. `currentBootId` is threaded through to
 * `classifyRecoveredJob` exactly as `getHistoricalRenderJob` already does, so
 * a job whose last recorded activity belongs to this same process's boot
 * (aged out of renderManager's bounded in-memory history) reads the same way
 * here as it does from `GET /api/renders/:id`.
 *
 * `excludeJobIds` exists for exactly one reason: a job that is currently
 * live in `renderManager` is also written to this journal (at queued/
 * preparing/rendering), and this function has no way to know that on its
 * own — it only ever reads the journal. Left unfiltered, a track's genuinely
 * in-flight render would be reconstructed as a non-terminal record with no
 * live owner and misclassified `"interrupted"`, which would be actively
 * wrong, not just imprecise. The caller (server/routes/renderHistory.ts)
 * supplies the live job ids `renderManager` currently holds for this slug —
 * "live always wins" applied at the list level, the same boundary
 * `getJobOrHistorical` in server/routes/renders.ts already enforces for one
 * job id. Applied before the limit slice, so an excluded live job never
 * silently shrinks the page below `limit`.
 */
export const recentRenderJobsForSlug = (
  reconstruction: RenderJournalReconstruction,
  slug: string,
  currentBootId: string,
  limit: number = RENDER_HISTORY_DEFAULT_LIMIT,
  excludeJobIds: ReadonlySet<string> = new Set(),
): readonly RecoveredRenderJob[] => {
  const bounded = Math.max(0, Math.min(limit, RENDER_HISTORY_MAX_LIMIT));

  return [...reconstruction.jobs.values()]
    .filter((job) => job.slug === slug && !excludeJobIds.has(job.jobId))
    .sort(
      (a, b) =>
        (reconstruction.order.get(b.jobId) ?? -1) -
        (reconstruction.order.get(a.jobId) ?? -1),
    )
    .slice(0, bounded)
    .map((job) => classifyRecoveredJob(job, currentBootId));
};

/**
 * A stable key for one exact render target — the same (slug, presetId) pair
 * `DestinationFinding` already carries. Exported so a caller building or
 * reading `buildMostRecentJobIndex`'s result always agrees on how a target
 * is named, rather than each call site re-joining the two strings its own
 * way.
 */
export const targetKey = (slug: string, presetId: string): string =>
  `${slug}::${presetId}`;

/**
 * The single most recent job for every exact (slug, presetId) target the
 * journal has ever seen, in one pass — built once per caller, not once per
 * target. This is what lets destination-health attach render context to
 * many findings from one journal read instead of a lookup-shaped rescan per
 * finding (`server/services/destinationHealthRenderContext.ts`).
 *
 * Deliberately not built from `recentRenderJobsForSlug`: that function's own
 * `limit` bounds how many of a *track's* most recent jobs it considers
 * (across every preset that track has), so a preset that simply renders less
 * often than its siblings could have its own true most-recent job fall
 * outside that bound. Grouping by the exact target instead of the track
 * means every target's answer is independent of how active its siblings are.
 *
 * `excludeJobIds` carries the same "live always wins" meaning
 * `recentRenderJobsForSlug` already gives it — a job id the caller already
 * knows is currently live in `renderManager` is never eligible to become
 * anyone's "most recent" answer.
 */
export const buildMostRecentJobIndex = (
  reconstruction: RenderJournalReconstruction,
  currentBootId: string,
  excludeJobIds: ReadonlySet<string> = new Set(),
): ReadonlyMap<string, RecoveredRenderJob> => {
  const bestOrder = new Map<string, number>();
  const bestRecord = new Map<string, RenderJournalJobRecord>();

  for (const job of reconstruction.jobs.values()) {
    if (excludeJobIds.has(job.jobId)) continue;
    const key = targetKey(job.slug, job.presetId);
    const index = reconstruction.order.get(job.jobId) ?? -1;
    if (index > (bestOrder.get(key) ?? -1)) {
      bestOrder.set(key, index);
      bestRecord.set(key, job);
    }
  }

  const result = new Map<string, RecoveredRenderJob>();
  for (const [key, record] of bestRecord) {
    result.set(key, classifyRecoveredJob(record, currentBootId));
  }
  return result;
};

/**
 * A short, human-friendly rendering of a recorded timestamp — "Today,
 * 14:32", "Yesterday, 18:04", "20 Sep, 13:10" — for operator scanning. Pure
 * and dependency-free like `formatBundleTimestamp`
 * (core/domain/delivery/releaseBundle.ts): `now` is a parameter rather than
 * `new Date()` so the day boundary is deterministic in tests. The caller is
 * expected to also keep the exact ISO value available (e.g. as a `title`
 * attribute) — this is a display convenience, never the value compared or
 * sorted on.
 */
export const formatRecentRenderTimestamp = (
  iso: string,
  now: Date = new Date(),
): string => {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;

  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(parsed.getHours())}:${pad(parsed.getMinutes())}`;

  const startOfDay = (date: Date) =>
    new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const dayDiff = Math.round(
    (startOfDay(now) - startOfDay(parsed)) / (24 * 60 * 60 * 1000),
  );

  if (dayDiff === 0) return `Today, ${time}`;
  if (dayDiff === 1) return `Yesterday, ${time}`;

  const MONTHS = [
    "Jan", "Feb", "Mar", "Apr", "May", "Jun",
    "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
  ];
  return `${parsed.getDate()} ${MONTHS[parsed.getMonth()]}, ${time}`;
};
