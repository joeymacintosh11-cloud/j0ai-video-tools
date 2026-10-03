/**
 * The aerender command line, and reading its progress output. Pure.
 *
 * aerender renders one composition of a project to one file:
 *   aerender -project <aep> -comp <name> -output <file>
 *            [-OMtemplate <output module>] -s <first frame> -e <last frame>
 *            -v ERRORS_AND_PROGRESS -close DO_NOT_SAVE_CHANGES
 *
 * The frame range comes from the track's audio, so one long template
 * composition serves every track; -close keeps the template untouched.
 */

export const buildAerenderArgs = (input: {
  readonly project: string;
  readonly composition: string;
  readonly output: string;
  /** Inclusive, so a 300-frame render ends at 299. */
  readonly durationInFrames: number;
  readonly outputModule: string | null;
}): string[] => {
  if (!Number.isInteger(input.durationInFrames) || input.durationInFrames < 1) {
    throw new Error(`aerender needs at least one frame; got ${input.durationInFrames}.`);
  }

  return [
    "-project",
    input.project,
    "-comp",
    input.composition,
    "-output",
    input.output,
    ...(input.outputModule === null ? [] : ["-OMtemplate", input.outputModule]),
    "-s",
    "0",
    "-e",
    String(input.durationInFrames - 1),
    "-v",
    "ERRORS_AND_PROGRESS",
    "-close",
    "DO_NOT_SAVE_CHANGES",
  ];
};

/**
 * The frame number in an aerender progress line, e.g.
 *   PROGRESS:  0:00:01:15 (46): 0 Seconds
 * or null for any other line.
 */
export const parseAerenderProgressFrame = (line: string): number | null => {
  const match = line.match(/^\s*PROGRESS:\s+\S+\s+\((\d+)\)/);
  return match ? Number(match[1]) : null;
};
