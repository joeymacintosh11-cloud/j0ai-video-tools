import assert from "node:assert/strict";
import test from "node:test";
import type { DestinationStatus } from "../core/domain/api/views.ts";
import {
  acceptedFormats,
  defaultDestination,
  destinationOptionLabel,
  draftMetadataFor,
  parseTagInput,
  planSummary,
  publishRequestBody,
} from "../ui/components/publishModel.ts";

const status = (id: string, state: DestinationStatus["state"], implemented = true): DestinationStatus => ({
  id,
  displayName: id,
  implemented,
  state,
  problem: state === "ready" ? null : "why",
  accountId: null,
  capabilities: implemented
    ? {
        formats: [{ presetId: "youtube-16x9", mode: "video" }],
        metadata: { titleMaxLength: 100, descriptionMaxLength: 100, maxTags: 5, tagMaxLength: 20, visibilities: ["private"] },
        thumbnail: false, scheduling: false, cancel: true, recover: true, idempotentPublish: true, accounts: false, network: false,
      }
    : null,
});

test("publish panel model: destination defaults, labels and accepted formats", () => {
  assert.equal(defaultDestination([status("youtube", "unavailable", false), status("a", "not_configured"), status("b", "ready")]), "b");
  assert.equal(defaultDestination([status("youtube", "unavailable", false), status("a", "not_configured")]), "a");
  assert.equal(defaultDestination([]), "");
  assert.equal(destinationOptionLabel(status("youtube", "unavailable", false)), "youtube — not implemented");
  assert.equal(destinationOptionLabel(status("a", "not_configured")), "a — not configured");
  assert.deepEqual(acceptedFormats(status("b", "ready")), ["youtube-16x9"]);
  assert.deepEqual(acceptedFormats(status("youtube", "unavailable", false)), []);
});

test("publish panel model: requests always name the renderer, tags are normalised, metadata seeds from the package", () => {
  const body = publishRequestBody("a-track", {
    destination: "local-mock", format: "square-1x1", renderer: "after-effects",
    title: "T", description: "D", tags: "#one, two,,\n#three", visibility: "unlisted",
  });
  assert.deepEqual(body, {
    destination: "local-mock",
    source: { track: "a-track", format: "square-1x1", renderer: "after-effects" },
    metadata: { title: "T", description: "D", tags: ["one", "two", "three"], visibility: "unlisted" },
  });
  assert.deepEqual(parseTagInput(" , #"), []);
  const pkg = {
    slug: "a-track",
    title: "A Track",
    platforms: [
      { platformId: "youtube", title: "YT title", description: "YT desc", keywords: ["k1"], caption: null, hashtags: null },
      { platformId: "reels", title: null, description: null, keywords: null, caption: "Caption line\nmore", hashtags: ["#h1"] },
    ],
  } as never;
  assert.deepEqual(draftMetadataFor(pkg, "youtube-16x9"), { title: "YT title", description: "YT desc", tags: "k1", visibility: "private" });
  assert.deepEqual(draftMetadataFor(pkg, "vertical-9x16"), { title: "Caption line", description: "Caption line\nmore", tags: "h1", visibility: "private" });
  assert.deepEqual(draftMetadataFor(null, "square-1x1"), { title: "", description: "", tags: "", visibility: "private" });
});

test("publish panel model: plan summaries name each distinct reason", () => {
  const plan = { ok: false, problems: [{ reason: "export_stale", message: "" }, { reason: "publication_metadata_invalid", message: "" }, { reason: "publication_metadata_invalid", message: "" }] } as never;
  assert.equal(planSummary(plan), "Export stale — re-render first · Publication metadata invalid");
  assert.equal(planSummary({ ok: true, problems: [] } as never), "Ready to publish");
});
