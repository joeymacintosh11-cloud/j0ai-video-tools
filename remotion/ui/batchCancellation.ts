import type {
  BatchContentPackageView,
  RenderJobView,
} from "../core/domain/api/views.ts";
import type { PlatformId } from "../core/domain/content/platformProfiles.ts";
import type { RenderPresetId } from "../core/domain/video/renderPresets.ts";
import { ApiRequestError, cancelRender, getRender } from "./api/client.ts";
import type { BatchSessionJobReference } from "./batchSession.ts";

const ACTIVE_STATUSES = new Set<RenderJobView["status"]>([
  "queued",
  "preparing",
  "rendering",
]);

export const isActiveRenderJob = (job: RenderJobView): boolean =>
  ACTIVE_STATUSES.has(job.status);

export type BatchCancellationTarget = {
  readonly actionId: string;
  readonly jobId: string;
  readonly slug: string;
  readonly platformId: PlatformId;
  readonly platformLabel: string;
  readonly presetId: RenderPresetId;
  readonly status: Extract<RenderJobView["status"], "queued" | "preparing" | "rendering">;
};

const matchesTarget = (
  target: BatchCancellationTarget,
  job: RenderJobView,
): boolean =>
  job.id === target.jobId &&
  job.slug === target.slug &&
  job.presetId === target.presetId;

/**
 * Resolves only active, exact jobs represented by the panel's current
 * authoritative package view. References for hidden tracks/platforms,
 * terminal or unknown jobs, and identity mismatches are deliberately omitted.
 */
export const selectBatchCancellationTargets = (
  view: BatchContentPackageView,
  references: readonly BatchSessionJobReference[],
  jobs: Readonly<Record<string, RenderJobView>>,
): readonly BatchCancellationTarget[] => {
  const visible = new Map<string, { readonly label: string }>();
  for (const track of view.tracks) {
    for (const platform of track.platforms) {
      if (platform.selected) {
        visible.set(`${track.slug}::${platform.platformId}`, {
          label: platform.label,
        });
      }
    }
  }

  const targets: BatchCancellationTarget[] = [];
  const seenJobs = new Set<string>();
  for (const reference of references) {
    const platform = visible.get(`${reference.slug}::${reference.platformId}`);
    const job = jobs[reference.jobId];
    if (
      !platform ||
      !job ||
      seenJobs.has(job.id) ||
      !isActiveRenderJob(job) ||
      job.id !== reference.jobId ||
      job.slug !== reference.slug ||
      job.presetId !== reference.presetId
    ) {
      continue;
    }
    seenJobs.add(job.id);
    targets.push({
      actionId: reference.actionId,
      jobId: job.id,
      slug: reference.slug,
      platformId: reference.platformId,
      platformLabel: platform.label,
      presetId: reference.presetId,
      status: job.status as BatchCancellationTarget["status"],
    });
  }
  return targets;
};

/** Multi-target cancellation names every exact visible target before acting. */
export const cancellationConfirmation = (
  targets: readonly BatchCancellationTarget[],
): string | null =>
  targets.length <= 1
    ? null
    : `Cancel ${targets.length} active renders?\n\n${targets
        .map((target) => `${target.slug} · ${target.platformLabel}`)
        .join("\n")}`;

const asApiError = (cause: unknown): ApiRequestError =>
  cause instanceof ApiRequestError
    ? cause
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: cause instanceof Error ? cause.message : String(cause),
      });

export type BatchCancellationAttempt =
  | {
      readonly kind: "accepted" | "terminal";
      readonly target: BatchCancellationTarget;
      readonly job: RenderJobView;
    }
  | {
      readonly kind: "unknown";
      readonly target: BatchCancellationTarget;
      readonly error: ApiRequestError;
    }
  | {
      readonly kind: "failed";
      readonly target: BatchCancellationTarget;
      readonly job: RenderJobView | null;
      readonly error: ApiRequestError;
    };

export type CancelOne = (jobId: string) => Promise<RenderJobView>;
export type ReadOne = (jobId: string) => Promise<RenderJobView>;

/**
 * Sends one request per exact job. A rejected request is reconciled with an
 * authoritative GET so completion/cancellation races cannot be fabricated as
 * failures. Each target settles independently.
 */
export const cancelBatchTargets = async (
  targets: readonly BatchCancellationTarget[],
  cancelOne: CancelOne = cancelRender,
  readOne: ReadOne = getRender,
): Promise<readonly BatchCancellationAttempt[]> =>
  Promise.all(
    targets.map(async (target): Promise<BatchCancellationAttempt> => {
      try {
        const job = await cancelOne(target.jobId);
        if (!matchesTarget(target, job)) {
          return {
            kind: "failed",
            target,
            job: null,
            error: new ApiRequestError(0, {
              code: "INTERNAL_ERROR",
              message: "The cancellation response did not match the requested render.",
            }),
          };
        }
        return {
          kind: isActiveRenderJob(job) ? "accepted" : "terminal",
          target,
          job,
        };
      } catch (cause) {
        const error = asApiError(cause);
        try {
          const job = await readOne(target.jobId);
          if (!matchesTarget(target, job)) {
            return { kind: "unknown", target, error };
          }
          return isActiveRenderJob(job)
            ? { kind: "failed", target, job, error }
            : { kind: "terminal", target, job };
        } catch (readCause) {
          const readError = asApiError(readCause);
          return readError.status === 404 || readError.code === "RENDER_JOB_NOT_FOUND"
            ? { kind: "unknown", target, error: readError }
            : { kind: "failed", target, job: null, error };
        }
      }
    }),
  );

/** Never let an older active response overwrite an observed terminal state. */
export const preferTerminalSnapshot = (
  previous: RenderJobView | undefined,
  incoming: RenderJobView,
): RenderJobView =>
  previous && !isActiveRenderJob(previous) && isActiveRenderJob(incoming)
    ? previous
    : incoming;
