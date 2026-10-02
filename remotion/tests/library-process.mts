import {
  CONTENT_LIBRARY_SCHEMA_VERSION,
  type ContentLibraryRecord,
} from "../core/domain/library/contentLibrary.ts";
import { appendContentLibraryRecord } from "../services/library/contentLibraryLog.ts";

/**
 * A separate process that appends to a content library.
 *
 * Real processes, because the claim under test is about processes: an
 * in-process mutex would make any number of "concurrent" appends pass while
 * saying nothing about the API server's render worker and a CLI render hitting
 * the same library at once. Mirrors tests/history-process.mts.
 *
 *   argv: <library root> <marker 0-15> <how many records>
 */

const [root, markerArgument, countArgument] = process.argv.slice(2);
const marker = Number(markerArgument);
const count = Number(countArgument);

const hex = (seed: string) => seed.repeat(64).slice(0, 64);

const record = (index: number): ContentLibraryRecord => ({
  schemaVersion: CONTENT_LIBRARY_SCHEMA_VERSION,
  // Unique per appender and per record, so dedup never suppresses one of these.
  recordId: `${marker.toString(16)}${index.toString(16).padStart(31, "0")}`,
  kind: "export",
  source: "render",
  generatedAt: new Date(Date.UTC(2026, 8, 18, 12, marker, index)).toISOString(),
  recordedAt: new Date().toISOString(),
  // Padded so a line is a realistic size rather than one small enough to land
  // atomically by accident.
  track: { slug: "probe", title: `Probe ${marker} ${"-".repeat(400)}`, artist: "Toshi", key: "F Minor", bpm: 100 },
  preset: { id: "youtube-16x9", label: "YouTube 16:9", width: 1920, height: 1080, fps: 30 },
  template: { composition: "ToshiBeatVisualizer", visualizerVersion: "toshi-1" },
  output: { path: "out/probe/youtube-16x9.mp4", bytes: 1000 + index, mtimeMs: index, ino: index },
  manifest: {
    path: "out/probe/youtube-16x9.manifest.json",
    inputFingerprint: hex("f"),
    inputs: { metadata: hex("a"), cover: hex("b"), audio: hex("c"), preset: hex("d"), visualizer: hex("e") },
  },
  renderJobId: `job-${marker}-${index}`,
  exportKind: "original",
  replaces: null,
});

process.send?.({ type: "ready" });

process.on("message", (message) => {
  if (message !== "go") return;

  void (async () => {
    const appended: string[] = [];
    const problems: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const result = await appendContentLibraryRecord(() => record(index), root);
      if (result.appended) appended.push(`${marker}-${index}`);
      else problems.push(result.problem ?? (result.duplicate ? "duplicate" : "not appended"));
    }

    process.send?.({ type: "done", appended, problems });
    process.disconnect();
  })();
});
