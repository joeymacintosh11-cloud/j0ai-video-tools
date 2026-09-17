/**
 * Whether the metadata form should take fresh values from the server.
 *
 * The form is re-rendered with a new track object after every refresh — window
 * focus included — so re-seeding on each one silently discarded whatever the
 * user was typing. Seeding is therefore driven by the metadata revision rather
 * than by object identity:
 *
 *  - switching track always re-seeds, since the old values belong elsewhere;
 *  - an unchanged revision means the refresh carried no news, so leave the form
 *    alone;
 *  - a changed revision re-seeds only when there is nothing to lose. If the
 *    file moved under an in-progress edit, the edit is kept and the user is
 *    told, instead of the change being applied behind their back.
 */
export type SeedDecision = "reseed" | "keep-local-edits" | "ignore";

export const decideSeed = ({
  switchedTrack,
  revisionChanged,
  dirty,
}: {
  readonly switchedTrack: boolean;
  readonly revisionChanged: boolean;
  readonly dirty: boolean;
}): SeedDecision => {
  if (switchedTrack) {
    return "reseed";
  }

  if (!revisionChanged) {
    return "ignore";
  }

  return dirty ? "keep-local-edits" : "reseed";
};
