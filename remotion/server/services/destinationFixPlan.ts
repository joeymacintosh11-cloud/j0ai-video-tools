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
} from "../../src/domain/delivery/destinationFixPlan.ts";
import type {
  DestinationFinding,
  DestinationHealthStatus,
} from "../../src/domain/delivery/destinationHealth.ts";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import { RENDER_PRESETS, type RenderPresetId } from "../../src/domain/video/renderPresets.ts";
import {
  deliverExport,
  deliveryStateForTarget,
} from "../../services/delivery/deliverExport.ts";
import {
  readDeliverySettings,
  resolveDeliveryRoot,
  type DeliverySettings,
} from "../../services/delivery/deliverySettings.ts";
import { generateReleaseBundle } from "../../services/delivery/releaseBundle.ts";
import { trackExportCoverage } from "../../services/tracks/exportCoverage.ts";
import { inspectTrack } from "../../services/tracks/inspectTrack.ts";
import { scanDestinationHealth } from "./destinationHealth.ts";
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
};

export type ApplyDestinationFixResult = {
  readonly plan: DestinationFixPlan;
  readonly results: readonly RemediationActionResult[];
};

const settle = (
  action: RemediationAction,
  status: RemediationActionResult["status"],
  reason: string | null,
): RemediationActionResult => ({
  actionId: action.id,
  kind: action.kind,
  slug: action.slug,
  presetId: action.presetId,
  status,
  reason,
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
        status: "skipped_already_fixed",
        reason: "This action no longer appears in a fresh plan — the underlying drift is already gone.",
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
        settled.set(id, await executeAction(action, settings));
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

  const results = [...requestedIds].map((id) => settled.get(id)!);
  return { plan, results };
};

const executeAction = async (
  action: RemediationAction,
  settings: DeliverySettings,
): Promise<RemediationActionResult> => {
  if (action.kind === "redeliver" || action.kind === "rerender_and_deliver") {
    return executeDeliveryAction(action, settings);
  }
  if (action.kind === "regenerate_release_bundle") {
    return executeBundleAction(action, settings);
  }
  return settle(action, "manual", "This action is not one apply-plan ever runs automatically.");
};

const executeDeliveryAction = async (
  action: RemediationAction,
  settings: DeliverySettings,
): Promise<RemediationActionResult> => {
  const slug = action.slug;
  const presetId = action.presetId;
  if (slug === null || presetId === null) {
    return settle(action, "failed", "This action is missing the track or format it names.");
  }

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
  const folder = inspection.metadata?.deliveryFolder ?? null;

  if (facts === undefined || facts.freshness !== "current") {
    if (action.kind === "redeliver") {
      // The canonical export changed since the plan was made; blindly
      // delivering it now would not be the fix this action described.
      return settle(action, "blocked", "The canonical export is no longer current. Re-run the fix plan.");
    }

    const batch = renderManager.startBatch([{ slug, preset: presetId }]);
    return settle(
      action,
      "queued",
      `Render queued (batch ${batch.batch.id}). Delivery happens automatically only if auto-deliver is on; otherwise re-run the fix plan once the render finishes.`,
    );
  }

  const state = deliveryStateForTarget(slug, presetId, facts, root, folder);
  if (state.status === "delivered") {
    return settle(action, "skipped_already_fixed", "Already matches what was delivered.");
  }

  const outcome = await deliverExport({ slug, presetId, settings });
  if (outcome.status === "delivered") {
    return settle(action, "completed", outcome.message);
  }
  return settle(action, "failed", outcome.message ?? `Delivery reported status "${outcome.status}".`);
};

const executeBundleAction = async (
  action: RemediationAction,
  settings: DeliverySettings,
): Promise<RemediationActionResult> => {
  const slug = action.slug;
  if (slug === null) {
    return settle(action, "failed", "This action is missing the track it names.");
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
