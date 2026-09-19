import type { DestinationFinding, DestinationFindingCode } from "./destinationHealth.ts";
import type { RenderPresetId } from "../video/renderPresets.ts";

/**
 * Turns destination health findings into a reviewed, typed plan of remediation
 * actions — never into anything that mutates the filesystem on its own.
 *
 * Detection (destinationHealth.ts) and remediation are kept as two separate
 * modules on purpose, exactly as the app keeps them as two separate steps:
 * this module only describes what *could* be done about a finding, using
 * nothing but the finding itself and (from the service layer, which is where
 * anything impure belongs) a fresh look at whether the canonical export is
 * current. Nothing here ever decides to run an action.
 */

/**
 * - redelivered:            copy the canonical export to the destination again
 * - rerender_and_deliver:   the canonical export itself is missing or stale,
 *                            so it must be rebuilt before it can be delivered
 * - regenerate_release_bundle: rewrite release.json/release.md from current state
 * - manual_review:          something a person must look at; never automated —
 *                            most importantly, anything that would require
 *                            deleting or overwriting a file this scanner did
 *                            not itself deliver
 *
 * There is no "no_action" kind: every finding this scanner can currently raise
 * maps to one of the four above. Adding an unreachable fifth kind "for later"
 * would be exactly the kind of unused abstraction this project avoids: if a
 * finding is ever added that truly implies no action, add the kind together
 * with the finding that needs it.
 */
export type RemediationActionKind =
  | "redeliver"
  | "rerender_and_deliver"
  | "regenerate_release_bundle"
  | "manual_review";

export type RemediationSafety = "safe" | "manual";

/**
 * Fixed per kind, exactly like a finding's severity: never a judgment call
 * made at the point an action is proposed. "safe" means the action reuses an
 * existing, already-idempotent, non-destructive operation (a copy, a render,
 * a bundle write); "manual" means either the fix requires deleting or
 * replacing content this scanner does not own, or the destination itself
 * cannot currently be trusted enough to act against.
 */
export const REMEDIATION_ACTION_SAFETY: Record<
  RemediationActionKind,
  RemediationSafety
> = {
  redeliver: "safe",
  rerender_and_deliver: "safe",
  regenerate_release_bundle: "safe",
  manual_review: "manual",
};

export type RemediationAction = {
  /** Stable across a plan/apply pair: a deterministic hash of kind+slug+preset+path. */
  readonly id: string;
  readonly kind: RemediationActionKind;
  readonly safety: RemediationSafety;
  /** False only for a manual_review action, or one blocked by a root problem. */
  readonly executable: boolean;
  readonly findingCodes: readonly DestinationFindingCode[];
  readonly slug: string | null;
  readonly presetId: RenderPresetId | null;
  readonly relativePath: string | null;
  readonly title: string;
  readonly reason: string;
  readonly expectedEffect: string;
  /** Other action ids in the same plan that must settle first. */
  readonly dependsOn: readonly string[];
};

/**
 * A small, deterministic, non-cryptographic string hash (FNV-1a, 32-bit),
 * rendered as 8 hex characters.
 *
 * Action ids must be identical between a `plan` call and the `apply-plan`
 * call that follows it, without either one trusting the other's data: the
 * server re-derives the plan fresh on apply and only ever acts on an id that
 * plan still produces itself. A cryptographic hash would be needless weight
 * for a value that is never a security boundary — it only has to be stable
 * and collision-unlikely across a few dozen actions in one plan.
 */
const fnv1a = (input: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

/**
 * `redeliver` and `rerender_and_deliver` are never proposed for the same
 * target at once — they are mutually exclusive alternatives for fixing the
 * exact same delivered-file drift, and which one applies can flip between two
 * plan calls purely because the canonical export's own freshness changed
 * underneath it. Treating them as the same identity here, for hashing only,
 * means an apply call started against one still finds "the delivery fix for
 * this target" in a freshly re-derived plan even if it now takes the other
 * form — instead of that action vanishing and a real, still-outstanding
 * problem being misreported as already fixed.
 */
const idKind = (kind: RemediationActionKind): RemediationActionKind =>
  kind === "rerender_and_deliver" ? "redeliver" : kind;

export const remediationActionId = (
  kind: RemediationActionKind,
  slug: string | null,
  presetId: RenderPresetId | null,
  relativePath: string | null,
): string =>
  fnv1a([idKind(kind), slug ?? "-", presetId ?? "-", relativePath ?? "-"].join(" "));

/** Builds one action, filling in safety and executability from its kind. */
export const remediationAction = (
  input: {
    readonly kind: RemediationActionKind;
    readonly findingCodes: readonly DestinationFindingCode[];
    readonly slug?: string | null;
    readonly presetId?: RenderPresetId | null;
    readonly relativePath?: string | null;
    readonly title: string;
    readonly reason: string;
    readonly expectedEffect: string;
    readonly dependsOn?: readonly string[];
    /** Overrides the safety-derived default — used only to block a normally-safe action on a root problem. */
    readonly executable?: boolean;
  },
): RemediationAction => {
  const slug = input.slug ?? null;
  const presetId = input.presetId ?? null;
  const relativePath = input.relativePath ?? null;
  const safety = REMEDIATION_ACTION_SAFETY[input.kind];

  return {
    id: remediationActionId(input.kind, slug, presetId, relativePath),
    kind: input.kind,
    safety,
    executable: input.executable ?? safety === "safe",
    findingCodes: input.findingCodes,
    slug,
    presetId,
    relativePath,
    title: input.title,
    reason: input.reason,
    expectedEffect: input.expectedEffect,
    dependsOn: input.dependsOn ?? [],
  };
};

/* ------------------------------------------------------------------ *
 * Messages
 * ------------------------------------------------------------------ */

export const describeRedeliver = (outputLabel: string): string =>
  `Re-deliver ${outputLabel}`;

export const describeRerenderAndDeliver = (outputLabel: string): string =>
  `Re-render and deliver ${outputLabel}`;

export const describeRegenerateReleaseBundle = (slug: string): string =>
  `Regenerate the release bundle for ${slug}`;

export const describeManualUnexpectedFile = (relativePath: string): string =>
  `Unexpected file: ${relativePath}. No deletion proposed — review and remove it yourself if it should not be there.`;

export const describeManualUnexpectedFolder = (relativePath: string): string =>
  `Unexpected folder: ${relativePath}. No deletion proposed — review and remove it yourself if it should not be there.`;

export const describeManualUnreadable = (relativePath: string): string =>
  `${relativePath} could not be examined. Restore access, then re-run the destination health scan.`;

export const describeManualRootProblem = (): string =>
  "The destination root itself is unavailable or cannot be trusted right now. Restore access to it, then re-run the destination health scan — no action here can safely run until it does.";

/* ------------------------------------------------------------------ *
 * Deduplication
 * ------------------------------------------------------------------ */

/**
 * Collapses actions that share an id (same kind, same target) into one,
 * merging their finding codes.
 *
 * The only case this currently matters for is a track's release bundle: up to
 * three different finding codes (missing, outdated, pair-mismatch) can all
 * point at the very same "regenerate the bundle" action for one slug, and a
 * plan must propose that exactly once, not three times.
 */
export const dedupeActions = (
  actions: readonly RemediationAction[],
): readonly RemediationAction[] => {
  const byId = new Map<string, RemediationAction>();

  for (const action of actions) {
    const existing = byId.get(action.id);
    if (existing === undefined) {
      byId.set(action.id, action);
      continue;
    }
    const mergedCodes = [
      ...new Set([...existing.findingCodes, ...action.findingCodes]),
    ];
    byId.set(action.id, { ...existing, findingCodes: mergedCodes });
  }

  return [...byId.values()];
};

/* ------------------------------------------------------------------ *
 * Summary
 * ------------------------------------------------------------------ */

export type RemediationPlanSummary = {
  readonly findings: number;
  readonly safeActions: number;
  readonly manualActions: number;
  readonly tracksAffected: number;
  readonly rendersRequired: number;
  readonly deliveriesRequired: number;
  readonly bundleUpdatesRequired: number;
  /** True when a root problem means nothing here is currently executable. */
  readonly blocked: boolean;
};

export const summarizeRemediationPlan = (
  findings: readonly DestinationFinding[],
  actions: readonly RemediationAction[],
  blocked: boolean,
): RemediationPlanSummary => {
  const tracksAffected = new Set(
    actions.map((action) => action.slug).filter((slug): slug is string => slug !== null),
  );

  return {
    findings: findings.length,
    safeActions: actions.filter((action) => action.safety === "safe").length,
    manualActions: actions.filter((action) => action.safety === "manual").length,
    tracksAffected: tracksAffected.size,
    rendersRequired: actions.filter((action) => action.kind === "rerender_and_deliver").length,
    deliveriesRequired: actions.filter(
      (action) => action.kind === "redeliver" || action.kind === "rerender_and_deliver",
    ).length,
    bundleUpdatesRequired: actions.filter(
      (action) => action.kind === "regenerate_release_bundle",
    ).length,
    blocked,
  };
};

/* ------------------------------------------------------------------ *
 * Execution results
 * ------------------------------------------------------------------ */

/**
 * - completed:            the operation ran and finished
 * - skipped_already_fixed: revalidated right before running, and the
 *                          condition that proposed this action was already
 *                          gone — nothing was done because nothing was needed
 * - queued:                a render was handed to the existing render queue;
 *                          with waitForCompletion left off, this apply call
 *                          does not wait for it — re-run the planner
 *                          afterwards, or apply again with waitForCompletion
 * - render_failed:         apply-plan followed the queued render to a
 *                          terminal state and it failed; nothing was
 *                          delivered, and the previous delivery (if any) is
 *                          untouched
 * - delivery_failed:       the render succeeded, but the delivery attempted
 *                          straight afterward failed; the newly rendered
 *                          canonical export is left in place, so a later
 *                          apply can retry delivery alone, with no render
 * - cancelled:             the render was cancelled (by this request or any
 *                          other) before it could finish; never proceeds to
 *                          delivery
 * - timed_out:             apply-plan stopped waiting before the render
 *                          reached a terminal state — this describes the
 *                          apply call, not the render, which was never
 *                          cancelled and may still finish on its own
 * - blocked:               a dependency of this action did not complete (or
 *                          was left out of this apply call), so this action
 *                          was never attempted; also used when the
 *                          destination or track cannot currently be trusted
 * - failed:                an immediate (non-render) delivery or bundle
 *                          operation ran and reported failure
 * - manual:                this action is not something apply-plan ever runs
 */
export type RemediationOutcomeStatus =
  | "completed"
  | "skipped_already_fixed"
  | "queued"
  | "render_failed"
  | "delivery_failed"
  | "cancelled"
  | "timed_out"
  | "blocked"
  | "failed"
  | "manual";

export type RemediationActionResult = {
  readonly actionId: string;
  readonly kind: RemediationActionKind;
  readonly slug: string | null;
  readonly presetId: RenderPresetId | null;
  readonly status: RemediationOutcomeStatus;
  readonly reason: string | null;
  /**
   * The render job this action queued or adopted, when one was involved.
   * Lets a caller correlate this action with the existing render job's own
   * status/SSE endpoint for live progress — never a second progress source.
   */
  readonly jobId: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  /**
   * Whether a narrow, single-track health scan confirmed the fix afterward.
   * Only ever attempted after a fully confirmed rerender_and_deliver
   * (render, then delivery, both settled); null for every other action or
   * outcome — this is a confirmation of one specific success, not a general
   * health field. A scan failure here is reported as `false`, never turned
   * into the action itself being reported as failed.
   */
  readonly healthConfirmed: boolean | null;
};
