/** Machine-local operational artifacts, independent of export freshness. */
export type WorkspaceReason =
  | "lock_owner_alive"
  | "lock_owner_missing"
  | "uncertain_owner"
  | "abandoned_partial"
  | "stale_job_file"
  | "malformed_status"
  | "cache_entry_invalid"
  | "recovery_required"
  | "cache_retention"
  | "cleanup_failed";
export type WorkspaceArtifact = {
  readonly path: string;
  readonly kind: "lock" | "run" | "cache" | "temporary" | "unknown";
  readonly reason: WorkspaceReason | null;
  readonly safe: boolean;
  readonly bytes: number;
  readonly createdAt: string | null;
  readonly details: string;
  /** Exact additional paths removed with this artifact (e.g. cache provenance). */
  readonly relatedPaths?: readonly string[];
};
export type WorkspaceInspection = {
  readonly configured: boolean;
  readonly problem: string | null;
  readonly artifacts: readonly WorkspaceArtifact[];
  readonly activeJobs: number;
  readonly orphanedLocks: number;
  readonly abandonedPartials: number;
  readonly recoverable: number;
  readonly manual: number;
  readonly cacheEntries: number;
  readonly cacheBytes: number;
  readonly oldestCache: string | null;
  readonly newestCache: string | null;
  readonly policy: { readonly maxEntries: number };
};
export type WorkspaceMaintenance = {
  readonly dryRun: boolean;
  readonly candidates: readonly WorkspaceArtifact[];
  readonly removed: readonly string[];
  readonly failures: readonly {
    path: string;
    reason: "cleanup_failed";
    message: string;
  }[];
  readonly inspection: WorkspaceInspection;
};
export type RendererWorkspace = {
  readonly inspect: () => Promise<WorkspaceInspection>;
  readonly maintain: (options: {
    readonly dryRun: boolean;
    readonly prune: boolean;
    readonly expectedPaths?: readonly string[];
  }) => Promise<WorkspaceMaintenance>;
};
