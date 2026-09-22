import {
  resolveMetadataTemplates,
  type PartialMetadataTemplates,
} from "../../src/domain/content/metadataTemplates.ts";
import { buildPlatformMetadata, type PlatformMetadataSubject } from "../../src/domain/content/platformMetadata.ts";
import type { ContentMetadataSettingsView } from "../../src/domain/api/views.ts";
import {
  TEMPLATE_FIELDS,
  templateFieldValue,
  withTemplateField,
} from "./templateFields.ts";

/**
 * A track's own template overrides — the innermost, highest-precedence
 * layer. Collapsed by default (§ handoff, "keep collapsed/optional"), so a
 * track that inherits everything shows nothing extra.
 *
 * Every field's preview is built with the exact same `buildPlatformMetadata`
 * the Content Package panel and the API use, given whatever this form
 * currently holds (draft overrides, not yet saved) layered over the real
 * global settings and built-in defaults — so what is shown here is exactly
 * what saving now would produce.
 */
export const ContentMetadataOverridesEditor: React.FC<{
  readonly value: PartialMetadataTemplates;
  readonly onChange: (next: PartialMetadataTemplates) => void;
  readonly contentMetadataSettings: ContentMetadataSettingsView | null;
  readonly subject: PlatformMetadataSubject;
  readonly slug: string;
  readonly disabled: boolean;
}> = ({ value, onChange, contentMetadataSettings, subject, slug, disabled }) => {
  const resolved = resolveMetadataTemplates(contentMetadataSettings?.templates, value);
  const overrideCount = TEMPLATE_FIELDS.filter(
    ({ platform, field }) => templateFieldValue(value, platform, field) !== undefined,
  ).length;

  return (
    <details className="field templates__details" id="content-metadata-overrides">
      <summary className="field__label">
        Content metadata overrides
        {overrideCount > 0 ? ` (${overrideCount} set)` : ""}
      </summary>
      <p className="field__hint">
        Wins over the global template and the built-in default, field by
        field. Everything left as &ldquo;Inherited&rdquo; follows the global
        Content Metadata settings, or the built-in Toshi copy if none is set
        there either.
      </p>

      <div className="templates">
        {TEMPLATE_FIELDS.map(({ platform, field, label }) => {
          const overridden = templateFieldValue(value, platform, field) !== undefined;
          const inheritedValue = (resolveMetadataTemplates(contentMetadataSettings?.templates, null)[platform] as Record<string, string>)[field];
          const editValue = overridden
            ? (resolved[platform] as Record<string, string>)[field]
            : inheritedValue;
          const previewMetadata = buildPlatformMetadata(slug, platform, subject, resolved);
          const previewText =
            field === "keywordsTemplate"
              ? (previewMetadata.keywords ?? []).join(", ")
              : field === "hashtagsTemplate"
                ? (previewMetadata.hashtags ?? []).join(" ")
                : field === "captionTemplate"
                  ? (previewMetadata.caption ?? "")
                  : field === "descriptionTemplate"
                    ? (previewMetadata.description ?? "")
                    : (previewMetadata.title ?? "");

          return (
            <div className="templates__field" key={`${platform}.${field}`}>
              <label className="field">
                <span className="field__label">
                  {label}{" "}
                  <em className={`templates__badge${overridden ? "" : " templates__badge--builtin"}`}>
                    {overridden ? "override" : "inherited"}
                  </em>
                </span>
                {overridden ? (
                  <textarea
                    className="field__input templates__textarea"
                    rows={field.includes("description") ? 5 : 2}
                    value={editValue}
                    disabled={disabled}
                    onChange={(event) =>
                      onChange(withTemplateField(value, platform, field, event.target.value))
                    }
                  />
                ) : (
                  <p className="templates__preview templates__preview--inherited">{inheritedValue}</p>
                )}
              </label>
              <div className="templates__row">
                <button
                  type="button"
                  className="button button--quiet"
                  disabled={disabled}
                  onClick={() =>
                    onChange(
                      withTemplateField(value, platform, field, overridden ? undefined : inheritedValue),
                    )
                  }
                >
                  {overridden ? "Clear override (inherit)" : "Override"}
                </button>
                <span className="templates__preview" title="Live preview, using the exact renderer Content Package uses">
                  {previewText}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </details>
  );
};
