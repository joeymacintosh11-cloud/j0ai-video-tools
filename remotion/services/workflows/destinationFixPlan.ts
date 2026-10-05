import {
  dedupeActions,
  describeManualRootProblem,
  describeManualUnexpectedFile,
  describeManualUnexpectedFolder,
  describeManualUnreadable,
  describeRedeliver,
  describeRegenerateReleaseBundle,
  describeRerenderAndDeliver,
  remediationAction,
  summarizeRemediationPlan,
  type RemediationAction,
  type RemediationActionResult,
  type RemediationPlanSummary,
} from "../../core/domain/delivery/destinationFixPlan.ts";
import type {
  DestinationFinding,
  DestinationHealthStatus,
} from "../../core/domain/delivery/destinationHealth.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { assertValidSlug } from "../../core/domain/tracks/slug.ts";
import { RENDER_PRESETS, type RenderPresetId } from "../../core/domain/video/renderPresets.ts";
import {
  DEFAULT_RENDERER_ID,
  remotionOnlyProblem,
  resolveTrackRenderer,
} from "../../core/domain/video/renderers.ts";
import {
  deliverExport,
  deliveryStateForTarget,
} from "../delivery/deliverExport.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "../delivery/deliverySettings.ts";
import { generateReleaseBundle } from "../delivery/releaseBundle.ts";
import { trackExportCoverage } from "../tracks/exportCoverage.ts";
import { inspectTrack } from "../tracks/inspectTrack.ts";
import { isTerminalStatus } from "./renderJobTypes.ts";
import { scanDestinationHealth } from "./destinationHealth.ts";
import { followRenderJob } from "./renderFollow.ts";
import { renderManager } from "./renderManager.ts";

/**
 * Turns a destination health scan into a reviewed plan of remediation
 * actions, without running any of them.
 *
 * "Expected" work is decided entirely from records the rest of the app
 * already trusts: `scanDestinationHealth` supplies the findings, and
 * `trackExportCoverage` — the same function delivery and export planning
 * already call — supplies whether the *canonical* export is current, which is
 * what decides between a plain re-delivery and a re-render.
 *
 * A destination that cannot currently be trusted (an identity change, or a
 * root/folder that cannot be listed) blocks planning entirely: nothing here
 * proposes re-rendering or re-delivering anything until access is restored,
 * because any "expected" state computed against an untrustworthy destination
 * would be a guess.
 */

export type DestinationFixPlan = {
  readonly status: DestinationHealthStatus;
  readonly catalogue: boolean;
  readonly root: string | null;
  readonly rootProblem: string | null;
  readonly scannedAt: string;
  readonly findings: readonly DestinationFinding[];
  /** Every proposed action, safe and manual alike, deduplicated. */
  readonly actions: readonly RemediationAction[];
  readonly summary: RemediationPlanSummary;
  readonly invalid: readonly { readonly slug: string; readonly reason: string }[];
};

export type PlanDestinationFixInput = {
  readonly slugs?: readonly string[];
  readonly settings?: DeliverySettings;
};

const namedSlugs = (slugs: readonly string[]): readonly string[] => {
  if (slugs.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one track."),
    );
  }
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const slug of slugs) {
    const valid = assertValidSlug(slug);
    if (!seen.has(valid)) {
      seen.add(valid);
      unique.push(valid);
    }
  }
  return unique;
};

const outputLabelFor = (slug: string, presetId: RenderPresetId): string =>
  `${slug} / ${RENDER_PRESETS[presetId].shortLabel}`;

export const planDestinationFix = async (
  input: PlanDestinationFixInput,
): Promise<DestinationFixPlan> => {
  const settings = input.settings ?? (await readDeliverySettings());
  const requested = input.slugs === undefined ? undefined : namedSlugs(input.slugs);
  const health = await scanDestinationHealth({ slugs: requested, settings });

  const findings: DestinationFinding[] = [
    ...health.rootFindings,
    ...health.tracks.flatMap((track) => track.findings),
  ];

  // Only these two codes mean the destination itself cannot currently be
  // trusted; `unexpected_track_folder` is also root-level but is an ordinary,
  // non-blocking orphan finding, handled with the rest below.
  const blockingRootFindings = health.rootFindings.filter(
    (finding) =>
      finding.code === "destination_root_identity_changed" ||
      finding.code === "destination_folder_unreadable",
  );

  // A root problem — the configured root itself missing, unreadable, or no
  // longer the same real directory it was configured against — means nothing
  // "expected" computed below can be trusted. Block everything rather than
  // guess: report the root findings as the only actions, all manual.
  if (blockingRootFindings.length > 0 || health.status === "unavailable" || health.status === "error") {
    const rootActions = dedupeActions(
      blockingRootFindings.length > 0
        ? blockingRootFindings.map((finding) =>
            remediationAction({
              kind: "manual_review",
              findingCodes: [finding.code],
              relativePath: finding.relativePath,
              title: "Restore destination access",
              reason: describeManualRootProblem(),
              expectedEffect: "None — this scanner will not act until the destination can be trusted again.",
            }),
          )
        : [
            remediationAction({
              kind: "manual_review",
              findingCodes: [],
              title: "Restore destination access",
              reason: health.rootProblem ?? describeManualRootProblem(),
              expectedEffect: "None — this scanner will not act until the destination can be trusted again.",
            }),
          ],
    );

    return {
      status: health.status,
      catalogue: health.catalogue,
      root: health.root,
      rootProblem: health.rootProblem,
      scannedAt: health.scannedAt,
      findings,
      actions: rootActions,
      summary: summarizeRemediationPlan(findings, rootActions, true),
      invalid: health.invalid,
    };
  }

  const actions: RemediationAction[] = [];

  // A folder listing failure blocks per-preset actions for that one track,
  // exactly as a root problem blocks the whole plan — the same "an untrusted
  // destination proposes nothing" rule, scoped to the track it applies to.
  const unreliableTrackSlugs = new Set(
    health.tracks
      .filter((track) => track.findings.some((f) => f.code === "destination_folder_unreadable"))
      .map((track) => track.slug),
  );

  for (const track of health.tracks) {
    if (track.findings.length === 0) continue;
    const { slug } = track;

    if (unreliableTrackSlugs.has(slug)) {
      for (const finding of track.findings) {
        actions.push(
          remediationAction({
            kind: "manual_review",
            findingCodes: [finding.code],
            slug,
            relativePath: finding.relativePath,
            title: `Restore access to ${track.folder ?? slug}`,
            reason: finding.code === "destination_folder_unreadable"
              ? describeManualUnreadable(finding.relativePath ?? (track.folder ?? slug))
              : finding.message,
            expectedEffect: "None — this track's folder cannot currently be trusted.",
          }),
        );
      }
      continue;
    }

    const trackDeliveryActionIds: string[] = [];
    const extraFindingCodesForSlug = new Set(
      track.findings
        .filter((finding) => finding.code === "track_folder_missing")
        .map((finding) => finding.code),
    );

    let inspection = null as Awaited<ReturnType<typeof inspectTrack>> | null;
    let coverage: ReturnType<typeof trackExportCoverage> | null = null;
    const coverageFor = async (presetId: RenderPresetId) => {
      if (inspection === null) inspection = await inspectTrack(slug);
      if (coverage === null) {
        coverage = trackExportCoverage(slug, inspection.metadata);
      }
      return coverage.find((entry) => entry.presetId === presetId) ?? null;
    };

    for (const finding of track.findings) {
      if (finding.code === "track_folder_missing") continue; // folded into per-preset actions below

      if (finding.code === "destination_file_unreadable") {
        actions.push(
          remediationAction({
            kind: "manual_review",
            findingCodes: [finding.code],
            slug,
            presetId: finding.presetId,
            relativePath: finding.relativePath,
            title: `Restore access: ${finding.relativePath ?? slug}`,
            reason: describeManualUnreadable(finding.relativePath ?? slug),
            expectedEffect: "None — this entry cannot currently be trusted.",
          }),
        );
        continue;
      }

      if (finding.code === "delivered_file_missing" || finding.code === "delivered_file_changed") {
        const presetId = finding.presetId;
        if (presetId === null) continue; // Not reachable: the scanner always names a preset for these codes.
        const facts = await coverageFor(presetId);

        // Repairing a delivery means re-copying or re-rendering Remotion's
        // export. A track that now prefers another renderer gets neither —
        // it is left for a person, with the reason, never queued as Remotion.
        const rendererProblem = remotionOnlyProblem(
          resolveTrackRenderer(inspection?.metadata?.renderer),
          "Delivery repair",
        );
        if (rendererProblem !== null) {
          actions.push(
            remediationAction({
              kind: "manual_review",
              findingCodes: [finding.code],
              slug,
              presetId,
              relativePath: finding.relativePath,
              title: `Review ${finding.relativePath ?? slug}`,
              reason: `${finding.message} ${rendererProblem}`,
              expectedEffect: "None — nothing is re-rendered or re-delivered for this track.",
            }),
          );
          continue;
        }

        const outputLabel = outputLabelFor(slug, presetId);
        const current = facts !== null && facts.freshness === "current";
        const action = remediationAction({
          kind: current ? "redeliver" : "rerender_and_deliver",
          findingCodes: [finding.code],
          slug,
          presetId,
          relativePath: finding.relativePath,
          title: current ? describeRedeliver(outputLabel) : describeRerenderAndDeliver(outputLabel),
          reason: current
            ? `${finding.message} The canonical export is current, so copying it again is enough.`
            : `${finding.message} The canonical export is missing or no longer current, so it must be rebuilt first.`,
          expectedEffect: current
            ? `Copies the current export to ${finding.relativePath ?? outputLabel} at the destination.`
            : `Re-renders ${outputLabel}, then delivers it once rendering finishes.`,
        });
        actions.push(action);
        trackDeliveryActionIds.push(action.id);
        continue;
      }

      if (finding.code === "unexpected_export_file") {
        actions.push(
          remediationAction({
            kind: "manual_review",
            findingCodes: [finding.code],
            slug,
            relativePath: finding.relativePath,
            title: `Unexpected file: ${finding.relativePath ?? slug}`,
            reason: describeManualUnexpectedFile(finding.relativePath ?? slug),
            expectedEffect: "None — nothing here deletes or moves a file it did not deliver.",
          }),
        );
        continue;
      }

      if (
        finding.code === "release_bundle_missing" ||
        finding.code === "release_bundle_outdated" ||
        finding.code === "release_bundle_pair_mismatch"
      ) {
        actions.push(
          remediationAction({
            kind: "regenerate_release_bundle",
            findingCodes: [finding.code],
            slug,
            relativePath: finding.relativePath,
            title: describeRegenerateReleaseBundle(slug),
            reason: finding.message,
            expectedEffect: `Rewrites release.json and release.md for ${slug} from current delivery state.`,
            // Filled in below, once every per-preset action for this slug is known.
          }),
        );
      }
    }

    // The bundle action (if any) must not run before every delivery action
    // this plan proposes for the same track has settled — a bundle written
    // from a still-drifting delivery would just describe the wrong thing.
    for (let i = 0; i < actions.length; i += 1) {
      const action = actions[i]!;
      if (action.kind !== "regenerate_release_bundle" || action.slug !== slug) continue;
      actions[i] = {
        ...action,
        dependsOn: [...new Set([...action.dependsOn, ...trackDeliveryActionIds])],
        findingCodes: [...new Set([...action.findingCodes, ...extraFindingCodesForSlug])],
      };
    }
    if (extraFindingCodesForSlug.size > 0 && trackDeliveryActionIds.length > 0) {
      for (let i = 0; i < actions.length; i += 1) {
        const action = actions[i]!;
        if (action.slug !== slug || !trackDeliveryActionIds.includes(action.id)) continue;
        actions[i] = {
          ...action,
          findingCodes: [...new Set([...action.findingCodes, ...extraFindingCodesForSlug])],
        };
      }
    }
  }

  // Root-level findings with no slug (an orphaned top-level folder) are
  // manual by definition — nothing here ever removes a folder it does not
  // recognise as one of its own tracks.
  for (const finding of health.rootFindings) {
    if (finding.code !== "unexpected_track_folder") continue;
    actions.push(
      remediationAction({
        kind: "manual_review",
        findingCodes: [finding.code],
        relativePath: finding.relativePath,
        title: `Unexpected folder: ${finding.relativePath ?? "destination root"}`,
        reason: describeManualUnexpectedFolder(finding.relativePath ?? "destination root"),
        expectedEffect: "None — nothing here deletes or moves a folder it did not deliver.",
      }),
    );
  }

  const deduped = dedupeActions(actions);

  return {
    status: health.status,
    catalogue: health.catalogue,
    root: health.root,
    rootProblem: health.rootProblem,
    scannedAt: health.scannedAt,
    findings,
    actions: deduped,
    summary: summarizeRemediationPlan(findings, deduped, false),
    invalid: health.invalid,
  };
};

/* ------------------------------------------------------------------ *
 * Execution
 * ------------------------------------------------------------------ */

/**
 * Runs the safe actions named by id, after re-deriving the plan fresh.
 *
 * The caller supplies only ids, never a filesystem path or an operation kind:
 * every action actually executed is one this same planner independently
 * produces right now, from the current state of the destination. An id from a
 * plan that is now stale (the drift it named has already been fixed, the
 * track changed, or the plan simply named something that no longer exists)
 * is reported as skipped rather than acted on blindly — this is the
 * revalidation the brief calls for, and it is also what makes running the
 * same apply twice safe.
 *
 * A dependent action (a release bundle regeneration that depends on a
 * delivery) only runs when every action it depends on was *also* named in
 * this same apply call and settled successfully. A caller applying only part
 * of a plan gets a conservative, individually-safe result rather than a bundle
 * silently written from a delivery it never asked for.
 *
 * No lock is taken across an apply. Every underlying operation
 * (`deliverExport`, `generateReleaseBundle`, a render) already owns its own
 * safety — a render/delivery target lock, or an idempotent, order-safe
 * bundle write — so two concurrent applies interleave exactly as two
 * concurrent manual deliveries already would, which is an existing, already
 * relied-upon guarantee, not a new one made here.
 */

export type ApplyDestinationFixInput = {
  readonly slugs?: readonly string[];
  readonly settings?: DeliverySettings;
  readonly actionIds: readonly string[];
  /**
   * Whether a rerender_and_deliver action should follow its render job to a
   * final result (completed/render_failed/delivery_failed/cancelled/timed_out)
   * before this call returns, rather than returning `queued` immediately.
   * Off by default — the existing, unchanged behaviour — so every prior
   * caller of this function keeps working exactly as it did.
   */
  readonly waitForCompletion?: boolean;
  /** Bounded wait, clamped to `MAX_WAIT_TIMEOUT_MS`. Ignored without waitForCompletion. */
  readonly timeoutMs?: number;
  /** Confirm these exact jobs from an earlier non-waiting apply, never queue replacements. */
  readonly followJobs?: readonly { readonly actionId: string; readonly jobId: string }[];
};

/** Long enough for most renders; short enough that one request cannot hang forever. */
const DEFAULT_WAIT_TIMEOUT_MS = 5 * 60 * 1000;
const MAX_WAIT_TIMEOUT_MS = 30 * 60 * 1000;

const resolveTimeoutMs = (value: number | undefined): number => {
  if (value === undefined) return DEFAULT_WAIT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    throw new TrackError(trackIssue("INVALID_REQUEST", "timeoutMs must be a positive number."));
  }
  return Math.min(value, MAX_WAIT_TIMEOUT_MS);
};

export type ApplyDestinationFixResult = {
  readonly plan: DestinationFixPlan;
  readonly results: readonly RemediationActionResult[];
};

const settle = (
  action: RemediationAction,
  status: RemediationActionResult["status"],
  reason: string | null,
  extra: {
    readonly jobId?: string | null;
    readonly startedAt?: string | null;
    readonly completedAt?: string | null;
    readonly healthConfirmed?: boolean | null;
  } = {},
): RemediationActionResult => ({
  actionId: action.id,
  kind: action.kind,
  slug: action.slug,
  presetId: action.presetId,
  status,
  reason,
  jobId: extra.jobId ?? null,
  startedAt: extra.startedAt ?? null,
  completedAt: extra.completedAt ?? null,
  healthConfirmed: extra.healthConfirmed ?? null,
});

export const applyDestinationFixPlan = async (
  input: ApplyDestinationFixInput,
): Promise<ApplyDestinationFixResult> => {
  if (input.actionIds.length === 0) {
    throw new TrackError(
      trackIssue("INVALID_REQUEST", "Name at least one action id to apply."),
    );
  }

  const settings = input.settings ?? (await readDeliverySettings());
  const settingsStillCurrent = async (): Promise<boolean> =>
    input.settings !== undefined || (await readDeliverySettings()).root === settings.root;
  const waitForCompletion = input.waitForCompletion === true;
  const timeoutMs = resolveTimeoutMs(input.timeoutMs);
  const followJobs = new Map<string, string>();
  for (const follow of input.followJobs ?? []) {
    if (!waitForCompletion || !input.actionIds.includes(follow.actionId) ||
        follow.jobId.length === 0 || followJobs.has(follow.actionId)) {
      throw new TrackError(trackIssue("INVALID_REQUEST", "followJobs must name distinct selected actions and requires waitForCompletion."));
    }
    followJobs.set(follow.actionId, follow.jobId);
  }
  const plan = await planDestinationFix({ slugs: input.slugs, settings });

  const requestedIds = new Set(input.actionIds);
  const byId = new Map(plan.actions.map((action) => [action.id, action]));
  const settled = new Map<string, RemediationActionResult>();

  // Every action a manual/unexecutable id named that still exists is reported
  // as manual and left alone; one that no longer exists at all is reported as
  // already fixed, never as an error — the plan simply moved on. Note that a
  // redeliver whose canonical export goes stale between plan and apply does
  // *not* fall into this branch: `remediationActionId` deliberately treats
  // redeliver and rerender_and_deliver as the same identity, so a fresh plan
  // still finds this id, now on an action with the other kind, and
  // `executeDeliveryAction` below re-decides which one actually happens.
  for (const id of requestedIds) {
    const action = byId.get(id);
    if (action === undefined) {
      settled.set(id, {
        actionId: id,
        kind: "manual_review",
        slug: null,
        presetId: null,
        status: plan.summary.blocked ? "blocked" : "skipped_already_fixed",
        reason: plan.summary.blocked
          ? "The destination cannot be trusted, so this action cannot be confirmed or applied."
          : "This action no longer appears in a fresh plan — the underlying drift is already gone.",
        jobId: null,
        startedAt: null,
        completedAt: null,
        healthConfirmed: null,
      });
      continue;
    }
    if (action.safety !== "safe" || !action.executable) {
      settled.set(id, settle(action, "manual", "This action is not one apply-plan ever runs automatically."));
    }
  }

  const toExecute = [...requestedIds]
    .map((id) => byId.get(id))
    .filter((action): action is RemediationAction => action !== undefined && action.safety === "safe" && action.executable);

  // Iterative topological execution: an action runs once every dependency it
  // has *in this apply* has settled; a dependency left out of this apply, or
  // one that did not complete cleanly, blocks it. Small and domain-specific on
  // purpose — this is not a generic workflow engine, just enough ordering for
  // "deliver, then bundle".
  const pending = new Map(toExecute.map((action) => [action.id, action]));
  while (pending.size > 0) {
    let progressed = false;

    for (const [id, action] of pending) {
      const relevantDeps = action.dependsOn.filter((dep) => requestedIds.has(dep));
      const unsettledDeps = relevantDeps.filter((dep) => !settled.has(dep));
      if (unsettledDeps.length > 0) continue;

      const missingDeps = action.dependsOn.filter((dep) => !requestedIds.has(dep));
      const failedDeps = relevantDeps.filter((dep) => {
        const result = settled.get(dep);
        return result === undefined || (result.status !== "completed" && result.status !== "skipped_already_fixed");
      });

      if (missingDeps.length > 0 || failedDeps.length > 0) {
        settled.set(
          id,
          settle(
            action,
            "blocked",
            missingDeps.length > 0
              ? "A prerequisite action was not included in this apply."
              : "A prerequisite action did not complete.",
          ),
        );
      } else {
        settled.set(id, await executeAction(action, settings, { waitForCompletion, timeoutMs, followJobs, settingsStillCurrent }));
      }

      pending.delete(id);
      progressed = true;
    }

    // A cycle should be unreachable — dependsOn only ever points at another
    // action for the same track, one level deep — but a safety net beats a
    // hang if that assumption is ever wrong.
    if (!progressed) {
      for (const [id, action] of pending) {
        settled.set(id, settle(action, "blocked", "Could not be ordered against its dependencies."));
      }
      break;
    }
  }

  // Health confirmation runs once, after every action in this call has
  // settled — so a bundle update this same call performed for the same
  // track is already reflected, rather than confirming health mid-sequence
  // against a track that is still, correctly, mid-fix.
  const confirmSlugs = [
    ...new Set(
      [...requestedIds]
        .map((id) => settled.get(id)!)
        .filter((r) => r.status === "completed" && r.jobId !== null)
        .map((r) => r.slug)
        .filter((slug): slug is string => slug !== null),
    ),
  ];

  if (confirmSlugs.length > 0) {
    const confirmedSlugs = await settingsStillCurrent()
      ? await confirmHealthForSlugs(confirmSlugs, settings)
      : new Set<string>();
    for (const id of requestedIds) {
      const result = settled.get(id)!;
      if (result.status === "completed" && result.jobId !== null && result.slug !== null) {
        settled.set(id, { ...result, healthConfirmed: confirmedSlugs.has(result.slug) });
      }
    }
  }

  const results = [...requestedIds].map((id) => settled.get(id)!);
  return { plan, results };
};

type ExecuteOptions = {
  readonly waitForCompletion: boolean;
  readonly timeoutMs: number;
  readonly followJobs: ReadonlyMap<string, string>;
  readonly settingsStillCurrent: () => Promise<boolean>;
};

const executeAction = async (
  action: RemediationAction,
  settings: DeliverySettings,
  options: ExecuteOptions,
): Promise<RemediationActionResult> => {
  if (action.kind === "redeliver" || action.kind === "rerender_and_deliver") {
    return executeDeliveryAction(action, settings, options);
  }
  if (action.kind === "regenerate_release_bundle") {
    return executeBundleAction(action, settings, options.settingsStillCurrent);
  }
  return settle(action, "manual", "This action is not one apply-plan ever runs automatically.");
};

/**
 * Finds a render job already queued or running for this exact track/format,
 * or queues a new one — via the render manager's own batch dedup, in one
 * call, so there is no window between "check" and "queue" for a second
 * caller to slip through. Two concurrent apply calls for the same target
 * converge on one job id this way, never two.
 */
const queueOrAdoptRender = (
  slug: string,
  presetId: RenderPresetId,
): { readonly jobId: string } | { readonly blocked: string } => {
  const { batch, locked } = renderManager.startBatch([{ slug, preset: presetId }]);
  const ownJob = batch.jobs.find((job) => job.slug === slug && job.presetId === presetId);
  if (ownJob) return { jobId: ownJob.id };

  if (locked.some((target) => target.slug === slug && target.preset === presetId)) {
    return {
      blocked: `Track "${slug}" is already rendering ${presetId} in another process. Wait for it to finish, then re-run the fix plan.`,
    };
  }

  // Not ours and not locked elsewhere: skipped because this exact target is
  // already queued or running in this same render manager, started by
  // another apply call, a render batch, or the render UI. Adopt it — this is
  // the "reuse existing job, never duplicate it" case §13 calls for.
  const existing = renderManager
    .listJobs()
    .find((job) => job.slug === slug && job.presetId === presetId && !isTerminalStatus(job.status));
  if (existing) return { jobId: existing.id };

  return { blocked: `Could not find or queue a render for "${slug}" / ${presetId}.` };
};

/**
 * Attempts delivery right now, revalidating everything fresh from disk.
 *
 * Shared by an immediate redeliver and by the post-render step of a followed
 * rerender_and_deliver — a wait can take real time, so nothing computed
 * before it (track existence, coverage, root) is trusted afterward; this
 * re-fetches all of it. `postRender` only changes wording and which failure
 * code a delivery failure gets, never the logic.
 */
const deliverIfNeeded = async (
  action: RemediationAction,
  settings: DeliverySettings,
  slug: string,
  presetId: RenderPresetId,
  jobId: string | null,
  startedAt: string | null,
  postRender: boolean,
  settingsStillCurrent: () => Promise<boolean>,
): Promise<RemediationActionResult> => {
  if (!(await settingsStillCurrent())) {
    return settle(action, "blocked", "The configured destination changed while this action was running. Create a fresh plan.", { jobId, startedAt });
  }
  const { root } = resolveDeliveryRoot(settings);
  if (root === null) {
    return settle(action, "blocked", "No destination is configured any more.", { jobId, startedAt });
  }

  const inspection = await inspectTrack(slug);
  if (!inspection.facts.trackDirExists) {
    return settle(action, "blocked", `Track "${slug}" no longer exists.`, { jobId, startedAt });
  }

  const coverage = trackExportCoverage(slug, inspection.metadata);
  const facts = coverage.find((entry) => entry.presetId === presetId);
  const folder = inspection.metadata?.deliveryFolder ?? null;

  if (facts === undefined || facts.freshness !== "current") {
    // Reachable after a render that just succeeded only if the export
    // changed again in the meantime (a metadata edit racing the render, most
    // plausibly). Never queue a second render from inside an already-bounded
    // wait — report plainly and let a fresh plan decide what happens next.
    const message = postRender
      ? "The export changed again while this render was running, so it is still not current. Re-run the fix plan."
      : "The canonical export is no longer current. Re-run the fix plan.";
    return settle(action, "blocked", message, { jobId, startedAt });
  }

  const state = deliveryStateForTarget(slug, presetId, facts, root, folder);
  if (state.status === "delivered") {
    return settle(action, "skipped_already_fixed", "Already matches what was delivered.", { jobId, startedAt });
  }

  // Repair is Remotion-only (see planning). Pinned, so a preference switched
  // during a followed render is refused instead of delivering that engine's export.
  const outcome = await deliverExport({ slug, presetId, settings, engine: DEFAULT_RENDERER_ID });
  const completedAt = new Date().toISOString();

  if (outcome.status === "delivered") {
    return settle(action, "completed", outcome.message, { jobId, startedAt, completedAt });
  }
  return settle(
    action,
    postRender ? "delivery_failed" : "failed",
    outcome.message ?? `Delivery reported status "${outcome.status}".`,
    { jobId, startedAt, completedAt },
  );
};

/**
 * A narrow health check — scoped to exactly the tracks named, never the
 * catalogue — to confirm a fix actually landed. One scan covers every track
 * this apply call fixed, rather than one scan per track.
 *
 * A root problem (the destination itself now untrustworthy) taints every
 * name at once: none of them can honestly be called confirmed. A scan
 * failure is reported the same way — unconfirmed, never turned into the
 * delivery itself being reported as failed, since it already succeeded.
 */
const confirmHealthForSlugs = async (
  slugs: readonly string[],
  settings: DeliverySettings,
): Promise<ReadonlySet<string>> => {
  try {
    const health = await scanDestinationHealth({ slugs, settings });
    if (health.status === "error" || health.status === "unavailable" ||
        health.status === "not_configured" || health.rootFindings.length > 0 ||
        health.invalid.length > 0) return new Set();
    return new Set(health.tracks.filter((track) => track.findings.length === 0).map((track) => track.slug));
  } catch {
    return new Set();
  }
};

/**
 * Follows a just-queued (or adopted) render job to a terminal state, then —
 * only if it completed — attempts delivery and a narrow health confirmation.
 *
 * A cancelled or failed render never reaches delivery. A timeout never
 * cancels the job or claims it failed: it means this call stopped waiting,
 * nothing more.
 */
const followRenderThenDeliver = async (
  action: RemediationAction,
  settings: DeliverySettings,
  jobId: string,
  startedAt: string,
  timeoutMs: number,
  settingsStillCurrent: () => Promise<boolean>,
): Promise<RemediationActionResult> => {
  const followed = await followRenderJob(jobId, timeoutMs);

  if (followed.outcome === "timed_out") {
    return settle(
      action,
      "timed_out",
      `Still waiting after ${Math.round(timeoutMs / 1000)}s (job ${jobId}, currently "${followed.job.status}"). ` +
        "The render was not cancelled and may still finish on its own — re-run the fix plan to confirm.",
      { jobId, startedAt },
    );
  }

  const job = followed.job;
  const completedAt = new Date().toISOString();

  if (job.status === "cancelled") {
    return settle(action, "cancelled", "The render was cancelled before delivery could run.", {
      jobId,
      startedAt,
      completedAt,
    });
  }
  if (job.status === "failed") {
    return settle(action, "render_failed", job.error?.message ?? "The render failed.", {
      jobId,
      startedAt,
      completedAt,
    });
  }

  const slug = action.slug!;
  const presetId = action.presetId!;
  // Health confirmation deliberately happens once, after the whole apply
  // call settles (see applyDestinationFixPlan) rather than here: a bundle
  // action in the same call that depends on this delivery has not run yet
  // at this point, and checking health this early would misreport a still-
  // pending bundle update as an unconfirmed fix.
  return deliverIfNeeded(action, settings, slug, presetId, jobId, startedAt, true, settingsStillCurrent);
};

const executeDeliveryAction = async (
  action: RemediationAction,
  settings: DeliverySettings,
  options: ExecuteOptions,
): Promise<RemediationActionResult> => {
  const slug = action.slug;
  const presetId = action.presetId;
  if (slug === null || presetId === null) {
    return settle(action, "failed", "This action is missing the track or format it names.");
  }

  const followedJobId = options.followJobs.get(action.id);
  if (followedJobId !== undefined) {
    let job;
    try {
      job = renderManager.getJob(followedJobId);
    } catch {
      return settle(action, "blocked", `Render job ${followedJobId} is no longer known. Create a fresh plan to recover.`);
    }
    if (job.slug !== slug || job.presetId !== presetId) {
      return settle(action, "blocked", "The supplied render job does not belong to this track and format.");
    }
    return followRenderThenDeliver(
      action, settings, followedJobId, job.startedAt ?? job.queuedAt, options.timeoutMs, options.settingsStillCurrent,
    );
  }

  if (!(await options.settingsStillCurrent())) {
    return settle(action, "blocked", "The configured destination changed. Create a fresh plan.");
  }

  // Checked before ever considering a render: queueing real render work for
  // a destination that is not even configured would be pure waste, and the
  // world may have changed this much since the plan was made.
  const { root } = resolveDeliveryRoot(settings);
  if (root === null) {
    return settle(action, "blocked", "No destination is configured any more.");
  }

  const inspection = await inspectTrack(slug);
  if (!inspection.facts.trackDirExists) {
    return settle(action, "blocked", `Track "${slug}" no longer exists.`);
  }

  const coverage = trackExportCoverage(slug, inspection.metadata);
  const facts = coverage.find((entry) => entry.presetId === presetId);

  if (facts !== undefined && facts.freshness === "current") {
    return deliverIfNeeded(action, settings, slug, presetId, null, null, false, options.settingsStillCurrent);
  }

  if (action.kind === "redeliver") {
    // The canonical export changed since the plan was made; blindly
    // delivering it now would not be the fix this action described.
    return settle(action, "blocked", "The canonical export is no longer current. Re-run the fix plan.");
  }

  const queued = queueOrAdoptRender(slug, presetId);
  if ("blocked" in queued) {
    return settle(action, "blocked", queued.blocked);
  }

  const jobId = queued.jobId;
  const startedAt = new Date().toISOString();

  if (!options.waitForCompletion) {
    return settle(
      action,
      "queued",
      `Render queued (job ${jobId}). Re-run the fix plan once it finishes, or apply again with waitForCompletion to follow it through delivery.`,
      { jobId, startedAt },
    );
  }

  return followRenderThenDeliver(action, settings, jobId, startedAt, options.timeoutMs, options.settingsStillCurrent);
};

const executeBundleAction = async (
  action: RemediationAction,
  settings: DeliverySettings,
  settingsStillCurrent: () => Promise<boolean>,
): Promise<RemediationActionResult> => {
  const slug = action.slug;
  if (slug === null) {
    return settle(action, "failed", "This action is missing the track it names.");
  }

  if (!(await settingsStillCurrent())) {
    return settle(action, "blocked", "The configured destination changed. Create a fresh plan.");
  }

  const result = await generateReleaseBundle({ slug, settings });

  if (result.problem !== null) {
    return settle(action, "failed", result.problem);
  }
  if (!result.generated) {
    return settle(action, "skipped_already_fixed", "The release bundle is already current.");
  }
  return settle(action, "completed", null);
};
