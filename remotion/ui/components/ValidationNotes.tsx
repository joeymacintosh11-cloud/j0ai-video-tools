import type { ValidationResult } from "../../core/domain/tracks/types.ts";

/**
 * Renders the server's own validation result verbatim.
 *
 * The UI does not decide what counts as valid — every message and code here
 * comes from the shared domain validation the CLI uses too.
 */
export const ValidationNotes: React.FC<{
  readonly validation: ValidationResult;
}> = ({ validation }) => {
  const { errors, warnings } = validation;

  if (errors.length === 0 && warnings.length === 0) {
    return <p className="muted">No problems reported.</p>;
  }

  return (
    <ul className="notes">
      {errors.map((issue) => (
        <li key={`error-${issue.code}-${issue.message}`} className="note note--error">
          <div className="note__code">{issue.code}</div>
          <div className="note__message">{issue.message}</div>
        </li>
      ))}
      {warnings.map((issue) => (
        <li
          key={`warning-${issue.code}-${issue.message}`}
          className="note note--warning"
        >
          <div className="note__code">{issue.code} · warning</div>
          <div className="note__message">{issue.message}</div>
        </li>
      ))}
    </ul>
  );
};
