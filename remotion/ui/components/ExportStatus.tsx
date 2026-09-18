import type { RenderOutputView } from "../../src/domain/api/views.ts";

/**
 * Per-format export state for one track, as a compact row of marks.
 *
 * A tick means the file is on disk — the only thing that actually counts as an
 * export. Work in flight is shown distinctly so a render in progress does not
 * read as a finished file.
 */
const mark = (output: RenderOutputView): { glyph: string; state: string; note: string } => {
  if (output.present) {
    return { glyph: "✓", state: "done", note: "rendered" };
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
  return { glyph: "—", state: "missing", note: "not rendered" };
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
          className={`export export--${state}`}
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
