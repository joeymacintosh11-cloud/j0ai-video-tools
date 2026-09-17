import {
  RENDER_PRESET_LIST,
  type RenderPresetId,
} from "../../src/domain/video/renderPresets.ts";

/**
 * Which export formats to render.
 *
 * The options come from the shared preset module, so adding a format here
 * needs no UI change. One format stays selected at all times — an empty
 * selection would only produce a request the server would reject.
 */
export const FormatPicker: React.FC<{
  readonly selected: readonly RenderPresetId[];
  readonly onChange: (next: readonly RenderPresetId[]) => void;
  readonly disabled?: boolean;
}> = ({ selected, onChange, disabled = false }) => (
  <div className="formats" role="group" aria-label="Export formats">
    <span className="formats__label">Formats</span>

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
