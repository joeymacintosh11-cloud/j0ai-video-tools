import {
  PLATFORM_LIST,
  type PlatformId,
} from "../../core/domain/content/platformProfiles.ts";

/**
 * Which platforms belong to the current Custom Content Package scope.
 *
 * Deliberately the same checkbox convention as FormatPicker.tsx (and the
 * Batch Content Package picker): one platform stays selected at all times —
 * an empty Custom selection is a valid, honestly-labelled state ("No
 * platforms selected", via ContentPackageStatus.not_configured) but making
 * it reachable by unchecking the last box reads as an accident rather than a
 * choice, exactly the reasoning FormatPicker already documents for formats.
 * Custom can still *start* at zero (Intent → Custom when the track intends
 * no platform at all) — this only stops removing the last remaining one.
 */
export const PlatformPicker: React.FC<{
  readonly selected: readonly PlatformId[];
  readonly onChange: (next: readonly PlatformId[]) => void;
  readonly label?: string;
  readonly className?: string;
}> = ({ selected, onChange, label = "Custom platforms", className }) => (
  <div
    className={className ? `formats ${className}` : "formats"}
    role="group"
    aria-label={label}
  >
    <span className="formats__label">{label}</span>

    {PLATFORM_LIST.map((platform) => {
      const checked = selected.includes(platform.id);
      const last = checked && selected.length === 1;

      return (
        <label
          key={platform.id}
          className={`format${checked ? " format--on" : ""}`}
          title={last ? "Keep at least one platform selected" : undefined}
        >
          <input
            type="checkbox"
            checked={checked}
            disabled={last}
            onChange={() => {
              onChange(
                checked
                  ? selected.filter((id) => id !== platform.id)
                  : // Keep canonical order rather than click order, so the
                    // package list and counts always read the same way.
                    PLATFORM_LIST.filter(
                      (candidate) =>
                        candidate.id === platform.id || selected.includes(candidate.id),
                    ).map((candidate) => candidate.id),
              );
            }}
          />
          <span className="format__name">{platform.label}</span>
        </label>
      );
    })}
  </div>
);
