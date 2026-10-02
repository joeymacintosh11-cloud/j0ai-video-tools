import { renderEngines } from "../adapters/renderEngines.mts";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import { DEFAULT_RENDERER_ID, RENDERER_IDS, type RendererId } from "../core/domain/video/renderers.ts";
import type { TrackMetadata } from "../core/domain/tracks/types.ts";
import type { AnalysisAudioResult } from "../services/tracks/prepareTrackAudio.ts";
import { publicLabel } from "../core/domain/tracks/paths.ts";
import type { AppendContentLibraryResult } from "../services/library/contentLibraryLog.ts";

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

/** One line saying whether a finished render made it into the content library. */
export const printLibraryOutcome = (outcome: AppendContentLibraryResult): void => {
  if (outcome.appended && outcome.record) {
    console.log(
      `✓ Recorded in the content library (${outcome.record.exportKind === "reexport" ? "re-export" : "original"}, ${outcome.record.recordId})`,
    );
  } else if (!outcome.duplicate) {
    console.log(
      `! Not recorded in the content library: ${outcome.problem ?? "unknown problem"}. The export itself is fine.`,
    );
  }
};

/**
 * `--engine <id>`: which renderer to render with. Absent means the default
 * (remotion), so every existing command line behaves exactly as before.
 *
 * Checked against this installation's engines while arguments are parsed, so
 * an unknown or unavailable renderer fails before any track is prepared. The
 * engine itself is only loaded (renderEngines.resolve) when a render starts.
 */
export const readEngineFlag = (argv: readonly string[]): RendererId => {
  const index = argv.indexOf("--engine");
  if (index === -1) return renderEngines.assertAvailable(undefined);

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    throw new TrackError(
      trackIssue("INVALID_RENDERER", `--engine needs a value: one of ${RENDERER_IDS.join(", ")}.`),
    );
  }

  return renderEngines.assertAvailable(value);
};

/** True for the argument that is --engine's value, so it is never read as a slug. */
export const isEngineFlagValue = (argv: readonly string[], index: number): boolean =>
  index > 0 && argv[index - 1] === "--engine";

export const ENGINE_FLAG_USAGE = [
  `  --engine <id>     Render engine. Installed: ${renderEngines.available.join(", ")}.`,
  `                    Defaults to ${DEFAULT_RENDERER_ID} when omitted.`,
];
