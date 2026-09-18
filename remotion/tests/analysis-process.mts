import { ensureAnalysisAudio } from "../services/tracks/prepareTrackAudio.ts";

/** One competing preparer, so concurrency is proven across real processes. */
const slug = process.argv[2];
process.send?.({ type: "ready" });
process.on("message", async (message) => {
  if (message !== "prepare") return;
  try {
    const result = await ensureAnalysisAudio(slug);
    process.send?.({ type: "prepared", regenerated: result.regenerated });
  } catch (error) {
    process.send?.({ type: "failed", message: (error as Error).message });
  }
  process.exit(0);
});
