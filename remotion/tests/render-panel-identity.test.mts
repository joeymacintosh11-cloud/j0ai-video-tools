import assert from "node:assert/strict";
import test from "node:test";
import type { RenderJobView } from "../core/domain/api/views.ts";
import { activeRenderFor } from "../ui/components/engineModel.ts";

const job = (changes: Partial<RenderJobView>): RenderJobView => ({
  id: "remotion-job",
  slug: "synthetic",
  presetId: "youtube-16x9",
  engine: "remotion",
  batchId: null,
  status: "rendering",
  progress: 0.5,
  framesRendered: 15,
  totalFrames: 30,
  fps: 30,
  elapsedMs: 100,
  startedAt: "2026-10-05T00:00:00Z",
  queuedAt: "2026-10-05T00:00:00Z",
  finishedAt: null,
  outputPath: null,
  outputLabel: null,
  error: null,
  ...changes,
});

test("reload/adoption follows the saved renderer, even when another engine's job is listed first", () => {
  const remotion = job({});
  const ae = job({ id: "ae-job", engine: "after-effects", status: "queued" });
  assert.equal(
    activeRenderFor([remotion, ae], "synthetic", "after-effects"),
    ae,
  );
  assert.equal(
    activeRenderFor([ae, remotion], "synthetic", "remotion"),
    remotion,
  );
  assert.equal(
    activeRenderFor([remotion], "synthetic", "after-effects"),
    undefined,
  );
  assert.equal(activeRenderFor([ae], "synthetic", "remotion"), undefined);
});

test("duplicate-request adoption also requires the requested format and track", () => {
  const youtube = job({ engine: "after-effects" });
  const square = job({
    id: "square-job",
    engine: "after-effects",
    presetId: "square-1x1",
  });
  assert.equal(
    activeRenderFor(
      [youtube, square],
      "synthetic",
      "after-effects",
      "square-1x1",
    ),
    square,
  );
  assert.equal(
    activeRenderFor([youtube], "synthetic", "after-effects", "square-1x1"),
    undefined,
  );
  assert.equal(
    activeRenderFor([square], "other-track", "after-effects"),
    undefined,
  );
});

test("settled/recovered or unknown-renderer jobs never become active progress", () => {
  for (const status of [
    "completed",
    "failed",
    "cancelled",
    "interrupted",
  ] as const) {
    assert.equal(
      activeRenderFor([job({ status })], "synthetic", "remotion"),
      undefined,
    );
  }
  assert.equal(
    activeRenderFor([job({ engine: null })], "synthetic", "remotion"),
    undefined,
  );
});
