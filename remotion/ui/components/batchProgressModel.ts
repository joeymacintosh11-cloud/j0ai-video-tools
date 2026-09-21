import type {
  BatchContentPackageView,
  ContentPackageBatchJobReferenceView,
  RenderJobView,
} from "../../src/domain/api/views.ts";
import type { ContentPackagePlatformEntry } from "../../src/domain/content/contentPackage.ts";

export type LiveTargetState =
  | "ready" | "missing" | "stale" | "blocked" | "queued" | "preparing" | "rendering" | "cancelling" | "checking";
export type LiveJobState = "queued" | "preparing" | "rendering" | "cancelling" | "completed" | "render_failed" | "cancelled";

export type LivePlatformEntry = {
  readonly platform: ContentPackagePlatformEntry;
  readonly state: LiveTargetState;
  readonly jobState: LiveJobState | null;
  readonly progressPercent: number | null;
  readonly error: string | null;
  readonly jobId: string | null;
};

export type LiveTrackEntry = {
  readonly slug: string;
  readonly title: string | null;
  readonly packageStatus: BatchContentPackageView["tracks"][number]["packageStatus"];
  readonly platforms: readonly LivePlatformEntry[];
  readonly ready: number;
  readonly total: number;
  readonly queued: number;
  readonly preparing: number;
  readonly rendering: number;
  readonly cancelling: number;
};

export type LiveBatchView = {
  readonly tracks: readonly LiveTrackEntry[];
  readonly totals: Readonly<Record<LiveTargetState, number>> & { readonly total: number };
};

const jobStateFor = (
  job: RenderJobView | undefined,
  cancellingJobIds: ReadonlySet<string>,
): LiveJobState | null => {
  if (!job) return null;
  if (cancellingJobIds.has(job.id) &&
    (job.status === "queued" || job.status === "preparing" || job.status === "rendering")) {
    return "cancelling";
  }
  switch (job.status) {
    case "queued": return "queued";
    case "preparing": return "preparing";
    case "rendering": return "rendering";
    case "completed": return "completed";
    case "failed": return "render_failed";
    case "cancelled": return "cancelled";
  }
};

const readinessState = (platform: ContentPackagePlatformEntry): LiveTargetState => {
  switch (platform.readiness) {
    case "ready": return "ready";
    case "missing": return "missing";
    case "stale": return "stale";
    case "blocked": return "blocked";
    case "rendering": return "rendering";
    case "not_selected": return "blocked";
  }
};

/** One target gets exactly one bucket; job state stays distinct from package readiness. */
export const deriveLiveBatchProgress = (
  view: BatchContentPackageView,
  references: readonly ContentPackageBatchJobReferenceView[],
  jobs: Readonly<Record<string, RenderJobView>>,
  refreshingSlugs: ReadonlySet<string> = new Set(),
  cancellingJobIds: ReadonlySet<string> = new Set(),
): LiveBatchView => {
  const refs = new Map(references.map((ref) => [`${ref.slug}::${ref.platformId}`, ref]));
  const totals: Record<LiveTargetState, number> & { total: number } = {
    ready: 0, missing: 0, stale: 0, blocked: 0, queued: 0, preparing: 0, rendering: 0, cancelling: 0, checking: 0, total: 0,
  };

  const tracks = view.tracks.map((track): LiveTrackEntry => {
    const platforms = track.platforms.filter((platform) => platform.selected).map((platform): LivePlatformEntry => {
      const ref = refs.get(`${track.slug}::${platform.platformId}`);
      const job = ref?.jobId ? jobs[ref.jobId] : undefined;
      const jobState = jobStateFor(job, cancellingJobIds);
      const awaitingRefresh = refreshingSlugs.has(track.slug);
      let state = readinessState(platform);
      if (jobState === "queued") state = "queued";
      else if (jobState === "preparing") state = "preparing";
      else if (jobState === "rendering") state = "rendering";
      else if (jobState === "cancelling") state = "cancelling";
      else if (jobState !== null && (awaitingRefresh || platform.readiness === "rendering")) state = "checking";
      totals[state]++;
      totals.total++;
      return {
        platform,
        state,
        jobState,
        progressPercent: job && (job.status === "preparing" || job.status === "rendering") &&
          (job.progress > 0 || job.framesRendered !== null)
          ? Math.round(job.progress * 100) : null,
        error: job?.error?.message ?? null,
        jobId: ref?.jobId ?? null,
      };
    });
    return {
      slug: track.slug,
      title: track.title,
      packageStatus: track.packageStatus,
      platforms,
      ready: platforms.filter((entry) => entry.state === "ready").length,
      total: platforms.length,
      queued: platforms.filter((entry) => entry.state === "queued").length,
      preparing: platforms.filter((entry) => entry.state === "preparing").length,
      rendering: platforms.filter((entry) => entry.state === "rendering").length,
      cancelling: platforms.filter((entry) => entry.state === "cancelling").length,
    };
  });

  return { tracks, totals };
};
