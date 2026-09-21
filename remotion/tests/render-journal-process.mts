import { randomUUID } from "node:crypto";
import {
  RENDER_JOURNAL_SCHEMA_VERSION,
  type RenderJournalEvent,
} from "../src/domain/render/renderJournal.ts";
import { appendRenderJournalEvent } from "../services/render/renderJournalLog.ts";

/**
 * A separate process that appends lifecycle events to one render journal.
 *
 * Real processes, because the claim under test is about processes: two
 * `renderManager` instances — the API server and, separately, a
 * `destination-fix-plan.mts --apply` run — can genuinely append to this same
 * journal at once, and only a real second process can show that is safe.
 *
 *   argv: <journal root> <marker> <how many jobs>
 */

const [root, marker, countArgument] = process.argv.slice(2);
const count = Number(countArgument);
const bootId = `boot-${marker}`;

const lifecycle = (jobId: string): RenderJournalEvent[] =>
  (["queued", "preparing", "rendering", "completed"] as const).map((state) => ({
    schemaVersion: RENDER_JOURNAL_SCHEMA_VERSION,
    eventId: randomUUID(),
    jobId,
    batchId: null,
    slug: `probe-${marker}`,
    presetId: "youtube-16x9",
    state,
    recordedAt: new Date().toISOString(),
    bootId,
    error: null,
  }));

process.send?.({ type: "ready" });

process.on("message", (message) => {
  if (message !== "go") return;

  void (async () => {
    const appended: string[] = [];
    const problems: string[] = [];

    for (let i = 0; i < count; i += 1) {
      const jobId = `${marker}-${i}`;
      for (const event of lifecycle(jobId)) {
        const result = await appendRenderJournalEvent(event, root);
        if (result.appended) appended.push(event.eventId);
        else problems.push(result.problem ?? "not appended");
      }
    }

    process.send?.({ type: "done", appended, problems });
    process.disconnect();
  })();
});
