import type { RendererStatus } from "../../core/domain/video/renderers.ts";
import type { RendererId } from "../../core/domain/video/renderers.ts";
import { engineOptions, engineStateLabel } from "./engineModel.ts";

/**
 * Which render engine this track's videos should come from.
 *
 * Exactly one is chosen at a time, so this is a radio group — styled like
 * FormatPicker's toggles so it reads as the same kind of control. The options
 * and their availability come from engineModel.ts and GET /api/renderers: an
 * engine that cannot run here is shown, dimmed and not pickable, with the
 * reason in its tooltip, rather than accepted and failing later.
 */
export const EnginePicker: React.FC<{
  readonly selected: RendererId;
  /** From GET /api/renderers; null while loading or unreachable. */
  readonly statuses: readonly RendererStatus[] | null;
  readonly onChange: (next: RendererId) => void;
  readonly disabled?: boolean;
  readonly label?: string;
  readonly className?: string;
}> = ({ selected, statuses, onChange, disabled = false, label = "Render engine", className }) => (
  <div
    className={className ? `formats ${className}` : "formats"}
    role="radiogroup"
    aria-label={label}
  >
    <span className="formats__label">{label}</span>

    {engineOptions(statuses, selected).map((option) => {
      const checked = option.id === selected;
      const stateLabel = engineStateLabel(option.state);

      return (
        <label
          key={option.id}
          className={[
            "format",
            checked ? "format--on" : "",
            option.selectable ? "" : "format--unavailable",
          ]
            .filter(Boolean)
            .join(" ")}
          title={option.problem ?? undefined}
        >
          <input
            type="radio"
            name="render-engine"
            value={option.id}
            checked={checked}
            disabled={disabled || !option.selectable}
            onChange={() => onChange(option.id)}
          />
          <span className="format__name">{option.label}</span>
          {stateLabel ? <span className="format__dims">{stateLabel}</span> : null}
        </label>
      );
    })}
  </div>
);
