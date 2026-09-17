import { TrackError } from "../src/domain/tracks/errors.ts";
import type { TrackMetadata } from "../src/domain/tracks/types.ts";
import type { AnalysisAudioResult } from "../services/tracks/prepareTrackAudio.ts";
import { publicLabel } from "../src/domain/tracks/paths.ts";

/**
 * Runs a CLI entry point, mapping the shared error model onto terminal output
 * and exit codes: an expected TrackError prints its message, anything else is
 * a bug and prints in full.
 */
export const runCli = (
  context: string,
  main: () => Promise<void> | void,
): void => {
  Promise.resolve()
    .then(main)
    .catch((error: unknown) => {
      if (error instanceof TrackError) {
        console.error(`\n✗ ${error.message}`);
        process.exit(1);
      }

      console.error(`\n✗ Unexpected error while ${context}:`);
      console.error(error);
      process.exit(1);
    });
};

export const printMetadataSummary = (metadata: TrackMetadata): void => {
  console.log(`    title:    ${metadata.title}`);
  console.log(`    artist:   ${metadata.artist}`);
  console.log(`    key:      ${metadata.key}`);
  console.log(`    bpm:      ${metadata.bpm}`);
  if (metadata.subtitle) {
    console.log(`    subtitle: ${metadata.subtitle}`);
  }
};

export const describeAnalysis = (
  analysis: AnalysisAudioResult,
  upToDateWording: string,
): string => {
  const label = publicLabel(analysis.relativePath);

  return analysis.regenerated
    ? `✓ Generated waveform analysis audio: ${label}`
    : `✓ ${upToDateWording}: ${label}`;
};
