import type { TrackStatus } from "../../core/domain/tracks/types.ts";

/**
 * The four track statuses, worded so `draft` reads as an expected step rather
 * than a failure — a freshly scaffolded track has key/bpm empty on purpose.
 */
const LABELS: Record<TrackStatus, string> = {
  ready: "Ready",
  draft: "Needs info",
  incomplete: "Missing files",
  invalid: "Invalid",
};

const TITLES: Record<TrackStatus, string> = {
  ready: "Fully valid and renderable.",
  draft: "Scaffolded — still waiting on key and BPM.",
  incomplete: "A required file is missing: cover.png, beat.wav or metadata.json.",
  invalid: "metadata.json is present but malformed.",
};

export const StatusBadge: React.FC<{ readonly status: TrackStatus }> = ({
  status,
}) => (
  <span className={`badge badge--${status}`} title={TITLES[status]}>
    {LABELS[status]}
  </span>
);
