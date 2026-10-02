import {
  RENDER_PRESET_LIST,
  type RenderPresetId,
} from "../../core/domain/video/renderPresets.ts";

/**
 * Which export formats to render.
 *
 * The options come from the shared preset module, so adding a format here
 * needs no UI change, and the toolbar, the metadata editor and the new-track
 * panel all label formats identically. One format stays selected at all times —
 * an empty selection would only produce a request the server would reject, and
 * an empty exportPresets is refused by metadata validation for the same reason.
 */
export const FormatPicker: React.FC<{
  readonly selected: readonly RenderPresetId[];
  readonly onChange: (next: readonly RenderPresetId[]) => void;
  readonly disabled?: boolean;
  /** Group label; the toolbar's wording by default. */
  readonly label?: string;
  readonly className?: string;
}> = ({ selected, onChange, disabled = false, label = "Formats", className }) => (
  <div
    className={className ? `formats ${className}` : "formats"}
    role="group"
    aria-label={label}
  >
    <span className="formats__label">{label}</span>

    {RENDER_PRESET_LIST.map((preset) => {
      const checked = selected.includes(preset.id);
      const last = checked && selected.length === 1;

      return (
        <label
          key={preset.id}
          className={`format${checked ? " format--on" : ""}`}
          title={`${preset.width}×${preset.height} · ${preset.aspectRatio}${
            last ? " — keep at least one format selected" : ""
          }`}
        >
          <input
            type="checkbox"
            checked={checked}
            disabled={disabled || last}
            onChange={() => {
              onChange(
                checked
                  ? selected.filter((id) => id !== preset.id)
                  : // Keep preset order rather than click order, so the queue
                    // and the labels always read the same way.
                    RENDER_PRESET_LIST.filter(
                      (candidate) =>
                        candidate.id === preset.id ||
                        selected.includes(candidate.id),
                    ).map((candidate) => candidate.id),
              );
            }}
          />
          <span className="format__name">{preset.shortLabel}</span>
          <span className="format__dims">
            {preset.width}×{preset.height}
          </span>
        </label>
      );
    })}
  </div>
);
