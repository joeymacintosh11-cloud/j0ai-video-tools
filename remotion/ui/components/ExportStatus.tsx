import type { RenderOutputView } from "../../src/domain/api/views.ts";

/**
 * Per-format export state for one track, as a compact row of marks.
 *
 * A tick means the file is on disk — the only thing that actually counts as an
 * export. Work in flight is shown distinctly so a render in progress does not
 * read as a finished file.
 *
 * Intent is a separate axis from all of that: a format this track does not ship
 * in is dimmed and gets its own mark, so "we are not making this one" never
 * looks like "this one is missing".
 */
const mark = (output: RenderOutputView): { glyph: string; state: string; note: string } => {
  if (output.present) {
    return {
      glyph: "✓",
      state: "done",
      note: output.intended ? "rendered" : "rendered, though not an intended format",
    };
  }
  if (output.active) {
    return { glyph: "●", state: "active", note: "rendering now" };
  }
  if (output.queued) {
    return { glyph: "·", state: "queued", note: "queued" };
  }
  if (output.empty) {
    return { glyph: "!", state: "empty", note: "file is empty — will be re-rendered" };
  }
  if (!output.intended) {
    return { glyph: "◦", state: "unintended", note: "not an intended format" };
  }
  return { glyph: "—", state: "missing", note: "intended, not rendered yet" };
};

export const ExportStatus: React.FC<{
  readonly exports: readonly RenderOutputView[];
  readonly compact?: boolean;
}> = ({ exports, compact = false }) => (
  <span className={`exports${compact ? " exports--compact" : ""}`}>
    {exports.map((output) => {
      const { glyph, state, note } = mark(output);

      return (
        <span
          key={output.presetId}
          className={`export export--${state}${output.intended ? "" : " export--unintended"}`}
          title={`${output.label}: ${note}`}
        >
          {compact ? null : (
            <span className="export__label">{output.label}</span>
          )}
          <span className="export__mark">{glyph}</span>
        </span>
      );
    })}
  </span>
);
