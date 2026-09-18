import {
  DELIVERY_REASON_LABELS,
  type DeliveryStatus as Status,
} from "../../src/domain/delivery/deliveryPaths.ts";
import type { RenderOutputView } from "../../src/domain/api/views.ts";

/**
 * Where each export stands at the destination.
 *
 * Kept apart from ExportStatus on purpose: an export being current and its copy
 * being at the destination are two different facts, and collapsing them into
 * one row of marks would make "rendered" and "delivered" look like the same
 * thing.
 */
const MARKS: Record<Status, { glyph: string; note: string }> = {
  delivered: { glyph: "✓", note: "Delivered" },
  pending: { glyph: "↑", note: "Not delivered yet" },
  outdated: { glyph: "!", note: "Delivered copy is out of date" },
  failed: { glyph: "✗", note: "Last delivery failed" },
  not_configured: { glyph: "◦", note: "No destination configured" },
};

export const DeliveryStatus: React.FC<{
  readonly exports: readonly RenderOutputView[];
  readonly compact?: boolean;
}> = ({ exports, compact = false }) => (
  <span className={`deliveries${compact ? " deliveries--compact" : ""}`}>
    {/* Only the formats this track ships in, since those are the only ones
        delivery ever considers. An unintended format that was delivered
        earlier is still shown, so an existing copy never disappears from
        view. */}
    {exports
      .filter(
        (output) => output.intended || output.delivery.status !== "pending",
      )
      .map((output) => {
        const { status, reason } = output.delivery;
        const { glyph, note } = MARKS[status];
        // The reason is the more specific of the two, so it wins where there is
        // one; the status note alone would otherwise repeat it verbatim.
        const detail =
          reason === null || status === "delivered"
            ? note
            : DELIVERY_REASON_LABELS[reason];

        return (
          <span
            key={output.presetId}
            className={`delivery delivery--${status}`}
            title={`${output.label}: ${detail}`}
          >
            {compact ? null : (
              <span className="delivery__label">{output.label}</span>
            )}
            <span
              className="delivery__mark"
              aria-label={compact ? `${output.label}: ${detail}` : undefined}
            >
              {glyph}
            </span>
            {compact ? null : <span className="delivery__note">{detail}</span>}
          </span>
        );
      })}
  </span>
);

/**
 * One badge summarising a track's deliveries, for the track list.
 *
 * A per-format row there would double the marks already shown for export
 * freshness, so the list gets the answer to "is anything waiting to go out?"
 * and the detail panel gets the breakdown.
 */
export const DeliverySummary: React.FC<{
  readonly exports: readonly RenderOutputView[];
}> = ({ exports }) => {
  const intended = exports.filter((output) => output.intended);
  const configured = intended.filter(
    (output) => output.delivery.status !== "not_configured",
  );

  if (configured.length === 0) return null;

  const waiting = configured.filter(
    (output) =>
      output.delivery.status === "pending" ||
      output.delivery.status === "outdated",
  );
  // Only current exports can actually be delivered, so a track waiting only on
  // formats that still need rendering is not reported as delivery work.
  const deliverable = waiting.filter(
    (output) => output.freshness === "current",
  );

  if (waiting.length === 0) {
    return (
      <span
        className="deliverybadge deliverybadge--delivered"
        title="Every intended export is at the destination"
      >
        sent
      </span>
    );
  }

  if (deliverable.length === 0) return null;

  return (
    <span
      className="deliverybadge deliverybadge--waiting"
      title={`${deliverable.length} current export${deliverable.length === 1 ? "" : "s"} not yet delivered`}
    >
      {deliverable.length} to send
    </span>
  );
};
