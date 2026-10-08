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
 *    told, instead of the change being applied behind their back;
 *  - unless nothing the form shows changed (another panel saved a field this
 *    form does not edit, such as the engagement choice): then the form
 *    "rebases" onto the new revision and keeps the edit, because saving it
 *    can no longer overwrite anything the user has not seen.
 */
export type SeedDecision = "reseed" | "rebase" | "keep-local-edits" | "ignore";

export const decideSeed = ({
  switchedTrack,
  revisionChanged,
  dirty,
  formFieldsChanged,
}: {
  readonly switchedTrack: boolean;
  readonly revisionChanged: boolean;
  readonly dirty: boolean;
  /** Whether the new revision differs in any field the form shows; unknown counts as changed. */
  readonly formFieldsChanged?: boolean;
}): SeedDecision => {
  if (switchedTrack) {
    return "reseed";
  }

  if (!revisionChanged) {
    return "ignore";
  }

  if (!dirty) return "reseed";
  return formFieldsChanged === false ? "rebase" : "keep-local-edits";
};
