import assert from "node:assert/strict";
import test from "node:test";
import { decideSeed } from "../ui/components/metadataSeed.ts";

/**
 * The metadata form is re-rendered with a fresh track object after every
 * refresh, window focus included. Re-seeding on each one discarded whatever
 * the user was typing, with no warning — so these pin the decision instead.
 */

test("a refresh carrying no change leaves the form alone", () => {
  for (const dirty of [false, true]) {
    assert.equal(
      decideSeed({ switchedTrack: false, revisionChanged: false, dirty }),
      "ignore",
    );
  }
});

test("an unedited form takes new server values when the file changed", () => {
  assert.equal(
    decideSeed({ switchedTrack: false, revisionChanged: true, dirty: false }),
    "reseed",
  );
});

test("an in-progress edit is never replaced by an external change", () => {
  assert.equal(
    decideSeed({ switchedTrack: false, revisionChanged: true, dirty: true }),
    "keep-local-edits",
  );
});

test("switching track always re-seeds, even with unsaved edits", () => {
  for (const revisionChanged of [false, true]) {
    assert.equal(
      decideSeed({ switchedTrack: true, revisionChanged, dirty: true }),
      "reseed",
    );
  }
});
