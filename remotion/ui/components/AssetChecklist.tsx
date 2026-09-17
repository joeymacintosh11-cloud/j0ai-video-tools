import type { TrackDetailView } from "../../src/domain/api/views.ts";

type RowState = "present" | "missing" | "stale";

const MARKS: Record<RowState, string> = {
  present: "✓",
  missing: "✗",
  stale: "!",
};

const Row: React.FC<{
  readonly name: string;
  readonly state: RowState;
  readonly path: string;
  readonly note?: string;
}> = ({ name, state, path, note }) => (
  <li className="assets__row">
    <span className={`assets__mark--${state}`} aria-hidden="true">
      {MARKS[state]}
    </span>
    <span className="assets__name">{name}</span>
    <span className="assets__path">
      {path}
      {note ? <span className="muted"> — {note}</span> : null}
    </span>
  </li>
);

/**
 * Describes metadata.json in terms the user can act on.
 *
 * A file that exists but has key/bpm still empty is the intended state of a
 * freshly scaffolded track, so it is not reported as missing or broken — only a
 * genuinely malformed file is.
 */
const metadataRow = (
  track: TrackDetailView,
): { state: RowState; note?: string } => {
  if (!track.metadataPresent) {
    return { state: "missing", note: "not created yet" };
  }

  if (track.metadataValid) {
    return { state: "present" };
  }

  return track.status === "invalid"
    ? { state: "missing", note: "malformed — see validation below" }
    : { state: "stale", note: "key and BPM not filled in yet" };
};

/**
 * The files that make up a track, plus whether analysis.wav and the render are
 * current.
 *
 * analysis.wav is generated, not authored: a missing or stale one is a prompt to
 * run prepare, not an error, so it reads differently from a missing cover.
 */
export const AssetChecklist: React.FC<{ readonly track: TrackDetailView }> = ({
  track,
}) => {
  const analysisState: RowState = !track.analysisPresent
    ? "stale"
    : track.analysisUpToDate
      ? "present"
      : "stale";

  const analysisNote = !track.analysisPresent
    ? "not generated yet — run prepare"
    : track.analysisUpToDate
      ? undefined
      : "older than beat.wav — run prepare";

  const metadata = metadataRow(track);

  return (
    <ul className="assets">
      <Row
        name="Cover"
        state={track.coverPresent ? "present" : "missing"}
        path={track.assets.cover}
      />
      <Row
        name="Audio"
        state={track.audioPresent ? "present" : "missing"}
        path={track.assets.beat}
      />
      <Row
        name="Metadata"
        state={metadata.state}
        path={track.assets.metadata}
        note={metadata.note}
      />
      <Row
        name="Analysis"
        state={analysisState}
        path={track.assets.analysis}
        note={analysisNote}
      />
      <Row
        name="Output"
        state={track.renderPresent ? "present" : "missing"}
        path={track.render.outputLabel}
        note={track.renderPresent ? undefined : "not rendered yet"}
      />
    </ul>
  );
};
