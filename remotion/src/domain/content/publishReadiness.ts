import { DELIVERY_REASON_LABELS, type DeliveryReason } from "../delivery/deliveryPaths.ts";
import type {
  ContentPackagePlatformEntry,
  ContentPackageView,
} from "./contentPackage.ts";
import type { PlatformId } from "./platformProfiles.ts";

/**
 * "Is this track ready to publish?" — a thin, derived layer over an
 * already-computed ContentPackageView (src/domain/content/contentPackage.ts),
 * never a second source of truth. Everything here is a pure function of
 * fields that view already carries; nothing in this module reads a
 * filesystem, calls an API, or scans a destination. See that module's own
 * comment for what actually backs each platform's readiness — this one only
 * adds the one question package readiness alone does not answer: *should
 * getting a current render also mean this platform is done*, given whether
 * a delivery destination is configured for it.
 *
 * "Ready to publish" in this product means the operator has everything they
 * need to publish manually — the finished video and its resolved copy, and,
 * if a delivery destination is configured, a current copy already sitting
 * there. It never means this tool published anything itself: there is no
 * social API integration in this product, and none of the wording here
 * should imply one.
 */

/**
 * One platform's publish-facing state — deliberately a different vocabulary
 * from `PlatformReadiness`, not a rename of it: `PlatformReadiness` answers
 * "does a current render exist for this platform", which says nothing about
 * delivery. `"ready"` here means the platform needs nothing further from the
 * operator; `"needs_delivery"` is the one state `PlatformReadiness` has no
 * equivalent for at all — a current render that a *configured* destination
 * does not yet hold, or no longer matches.
 */
export type PublishPlatformState =
  | "ready"
  | "needs_delivery"
  | "missing"
  | "stale"
  | "rendering"
  | "blocked"
  | "not_selected";

export type PublishActionKind =
  | "build"
  | "rerender"
  | "deliver"
  | "review_destination"
  | "wait"
  | "fix_validation";

export type PublishAction = {
  readonly kind: PublishActionKind;
  /** Short, product-facing verb — "Build", "Re-render", "Deliver", ... */
  readonly label: string;
};

export type PublishPlatformEntry = {
  readonly platformId: PlatformId;
  readonly label: string;
  readonly state: PublishPlatformState;
  /** Whether a delivery destination is configured for this exact platform. */
  readonly deliveryRequired: boolean;
  readonly deliveryReason: DeliveryReason | null;
  readonly deliveredAt: string | null;
  /**
   * One concrete, human-readable line for why this platform needs delivery
   * attention specifically — reusing DELIVERY_REASON_LABELS, the same
   * vocabulary delivery/destination health already use, never a new one.
   * Null whenever `state` is not `"needs_delivery"`.
   */
  readonly deliveryNote: string | null;
  /** The underlying package entry, for anything a caller still needs directly (metadata, filenames, blockers, staleReasons, ...). */
  readonly platform: ContentPackagePlatformEntry;
  /** Deterministic, state-derived — never null except for "ready" and "not_selected". */
  readonly primaryAction: PublishAction | null;
};

export type PublishPackageStatus =
  | "ready_to_publish"
  | "needs_delivery"
  | "incomplete"
  | "stale"
  | "blocked"
  | "not_configured";

export type PublishReadinessCounts = {
  readonly selected: number;
  /** Fully done: current render, and delivered wherever delivery is configured. */
  readonly ready: number;
  readonly needsDelivery: number;
  readonly missing: number;
  readonly stale: number;
  readonly rendering: number;
  readonly blocked: number;
};

export type PublishReadinessView = {
  readonly status: PublishPackageStatus;
  readonly platforms: readonly PublishPlatformEntry[];
  readonly counts: PublishReadinessCounts;
  /** One dominant, actionable next step for the whole package — see derivePackagePrimaryAction. */
  readonly primaryAction: PublishAction | null;
  /** Which selected platforms the package-level primaryAction actually covers. */
  readonly primaryActionTargets: readonly PlatformId[];
};

/**
 * A delivery attempt that never happened yet ("pending") reads as routine —
 * the ordinary next step for a freshly-rendered platform. A delivery that
 * *drifted* after having succeeded (the destination copy was deleted or
 * changed, or a copy attempt itself failed) reads as something worth a
 * second look, even though the mechanical fix is the same "Deliver" button
 * — this is exactly the distinction §39 of the milestone brief asks for
 * ("Delivery needs attention") without treating it as a different backend
 * state.
 */
const isDeliveryDrift = (reason: DeliveryReason | null): boolean =>
  reason === "destination_missing" ||
  reason === "destination_modified" ||
  reason === "copy_failed" ||
  reason === "destination_changed";

const stateFor = (
  platform: ContentPackagePlatformEntry,
): { readonly state: PublishPlatformState; readonly deliveryRequired: boolean } => {
  if (!platform.selected) return { state: "not_selected", deliveryRequired: false };
  if (platform.readiness === "blocked") return { state: "blocked", deliveryRequired: false };
  if (platform.readiness === "missing") return { state: "missing", deliveryRequired: false };
  if (platform.readiness === "stale") return { state: "stale", deliveryRequired: false };
  if (platform.readiness === "rendering") return { state: "rendering", deliveryRequired: false };

  // readiness === "ready": a current render exists. Whether the platform
  // itself is "ready" or "needs_delivery" now depends only on whether a
  // destination is configured for it and, if so, whether that copy is
  // current — never on anything this module re-derives itself.
  const deliveryRequired = platform.deliveryStatus !== "not_configured";
  const delivered = platform.deliveryStatus === "delivered";
  return {
    state: !deliveryRequired || delivered ? "ready" : "needs_delivery",
    deliveryRequired,
  };
};

const primaryActionFor = (
  state: PublishPlatformState,
  deliveryReason: DeliveryReason | null,
): PublishAction | null => {
  switch (state) {
    case "missing":
      return { kind: "build", label: "Build" };
    case "stale":
      return { kind: "rerender", label: "Re-render" };
    case "rendering":
      return { kind: "wait", label: "Wait" };
    case "blocked":
      return { kind: "fix_validation", label: "Fix validation" };
    case "needs_delivery":
      return isDeliveryDrift(deliveryReason)
        ? { kind: "review_destination", label: "Review destination" }
        : { kind: "deliver", label: "Deliver" };
    case "ready":
    case "not_selected":
      return null;
  }
};

/** One package-wide priority order, most urgent first — used by both the aggregate status and the single package-level action below. */
const STATUS_PRIORITY: readonly PublishPlatformState[] = [
  "blocked",
  "missing",
  "stale",
  "needs_delivery",
  "rendering",
  "ready",
];

export const derivePublishReadiness = (pkg: ContentPackageView): PublishReadinessView => {
  const platforms: PublishPlatformEntry[] = pkg.platforms.map((platform) => {
    const { state, deliveryRequired } = stateFor(platform);
    const deliveryNote =
      state === "needs_delivery"
        ? platform.deliveryReason !== null
          ? DELIVERY_REASON_LABELS[platform.deliveryReason]
          : "Not delivered yet"
        : null;

    return {
      platformId: platform.platformId,
      label: platform.label,
      state,
      deliveryRequired,
      deliveryReason: platform.deliveryReason,
      deliveredAt: platform.deliveredAt,
      deliveryNote,
      platform,
      primaryAction: primaryActionFor(state, platform.deliveryReason),
    };
  });

  const selected = platforms.filter((p) => p.state !== "not_selected");

  const counts: PublishReadinessCounts = {
    selected: selected.length,
    ready: selected.filter((p) => p.state === "ready").length,
    needsDelivery: selected.filter((p) => p.state === "needs_delivery").length,
    missing: selected.filter((p) => p.state === "missing").length,
    stale: selected.filter((p) => p.state === "stale").length,
    rendering: selected.filter((p) => p.state === "rendering").length,
    blocked: selected.filter((p) => p.state === "blocked").length,
  };

  const status: PublishPackageStatus =
    selected.length === 0
      ? "not_configured"
      : counts.blocked > 0
        ? "blocked"
        : counts.missing > 0 || counts.rendering > 0
          ? "incomplete"
          : counts.stale > 0
            ? "stale"
            : counts.needsDelivery > 0
              ? "needs_delivery"
              : "ready_to_publish";

  // The single most urgent state actually present, by STATUS_PRIORITY — the
  // package-level action always targets exactly the platforms in that one
  // state, never a blend of several ("Build 2 missing" never also silently
  // covers a stale one; the operator sees that action once it exists).
  const dominant = STATUS_PRIORITY.find((candidate) =>
    selected.some((p) => p.state === candidate),
  );
  const targets = dominant === undefined
    ? []
    : selected.filter((p) => p.state === dominant);

  const primaryAction = packagePrimaryAction(dominant, targets);

  return {
    status,
    platforms,
    counts,
    primaryAction,
    primaryActionTargets: targets.map((p) => p.platformId),
  };
};

const plural = (count: number, noun: string): string =>
  `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * One package-level action, worded around exactly how many platforms it
 * covers ("Build 2 missing assets"), per §20 of the milestone brief — never
 * a generic "Fix everything": a caller reads `primaryActionTargets` to know
 * exactly which platforms clicking it would affect, and reuses the existing
 * per-scope build/deliver panels for the actual action, this module only
 * ever describes what to do and to what.
 */
const packagePrimaryAction = (
  dominant: PublishPlatformState | undefined,
  targets: readonly PublishPlatformEntry[],
): PublishAction | null => {
  if (dominant === undefined || targets.length === 0) return null;

  switch (dominant) {
    case "blocked":
      return { kind: "fix_validation", label: "Fix validation" };
    case "missing":
      return { kind: "build", label: `Build ${plural(targets.length, "missing asset")}` };
    case "stale":
      return { kind: "rerender", label: `Re-render ${plural(targets.length, "stale asset")}` };
    case "needs_delivery":
      return targets.some((p) => isDeliveryDrift(p.deliveryReason))
        ? { kind: "review_destination", label: "Review destination issue" }
        : { kind: "deliver", label: `Deliver ${plural(targets.length, "ready asset")}` };
    case "rendering":
      return { kind: "wait", label: `Wait — rendering ${plural(targets.length, "asset")}` };
    case "ready":
    case "not_selected":
      return null;
  }
};
