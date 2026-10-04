import { execFile, spawn as nodeSpawn } from "node:child_process";
import { constants, existsSync, readdirSync, statSync } from "node:fs";
import { copyFile, readFile, rename, open, rm, mkdir } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { secondsToFrames } from "../../core/domain/video/compositionConfig.ts";
import { DEFAULT_RENDER_PRESET_ID, renderPreset } from "../../core/domain/video/renderPresets.ts";
import { buildTemplateData, type TemplateData } from "../../core/domain/video/templateData.ts";
import type { VisualizerProps } from "../../core/domain/video/visualizerProps.ts";
import { makeCancelSignal, type ResolvedVideo, type RenderEngine, type RenderSession } from "../../core/ports/renderEngine.ts";
import { probeAudioDurationInSeconds } from "../../services/tracks/audioDuration.ts";
import { buildAerenderArgs, parseAerenderProgressFrame } from "./aerenderCommand.mts";
import {
  describeAerenderNotFound,
  discoverInstalledAerender,
  type AerenderDiscovery,
} from "./aerenderDiscovery.mts";
import { readAfterEffectsConfig, type AfterEffectsConfig } from "./afterEffectsConfig.mts";
import {
  missingTemplateFiles,
  renderedMediaProblems,
  STAGED_ASSET_NAMES,
  templateText,
  templateTextMarker,
  templateTextStatus,
  templateWarnings,
} from "./templateContract.mts";

import { PreparationError } from "./afterEffectsScripting.mts";
import { hashProject, prepareAfterEffectsTemplate } from "./templatePreparation.mts";
import { acquireAfterEffectsStagingLock, type WorkspaceLock } from "./stagingLock.mts";
import { prunePreparedCache } from "./workspace.mts";
import { afterEffectsTemplateIdentity } from "./templateIdentity.mts";

export { STAGED_ASSET_NAMES };

/**
 * The After Effects implementation of the RenderEngine port — a proof of
 * concept that drives aerender, After Effects' command-line renderer, across
 * a process boundary. Nothing Adobe-specific leaves this folder.
 *
 * One render:
 *
 *  open()     reads after-effects.local.json (RENDERER_NOT_CONFIGURED if
 *             missing or wrong), finds aerender (RENDERER_UNAVAILABLE if not),
 *             and hashes the project file — the template's version.
 *  resolve()  picks the composition for the format, takes the frame count
 *             from the track's audio, copies the track's images and audio
 *             to fixed names beside the configured dataFile, and writes the
 *             template-data sidecar (core/domain/video/templateData.ts)
 *             there. The project imports the images and audio as footage;
 *             its text is written in from the sidecar when it is built. A
 *             project that never mentions the cover or audio file, or
 *             whose text marker belongs to another track, is
 *             RENDERER_NOT_CONFIGURED before aerender starts — it would
 *             render black and silent, or with another track's title
 *             (templateContract.mts). Auto mode prepares validated per-track
 *             working copies from an immutable snapshot instead.
 *  render()   runs aerender for exactly those frames into a sibling of the
 *             staging path, reports its PROGRESS lines, and moves the file
 *             into place once ffprobe sees video and audio in it. A
 *             non-zero exit, a missing file, a file without audio or an output
 *             module that is not MP4 is a RENDER_FAILED with the reason.
 *  close()    stops aerender if it is still running.
 *
 * It never falls back to Remotion: every failure is an error.
 */

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "public");

/** Where aerender writes, beside the staging path; moved onto it afterwards. */
const RENDER_FILE_NAME = "after-effects-render.mp4";

/** How long aerender gets to stop after a cancel before it is killed. */
const KILL_GRACE_MS = 5_000;

const TAIL_LINES = 12;

export type AfterEffectsEngineDeps = {
  readonly readConfig: () => AfterEffectsConfig;
  readonly discover: () => AerenderDiscovery;
  readonly probeAudioDurationInSeconds: (file: string) => Promise<number>;
  /** The stream types ("video", "audio") in a rendered file. */
  readonly probeStreamTypes: (file: string) => Promise<string[]>;
  readonly spawn: typeof nodeSpawn;
  readonly publicDir: string;
  readonly prepareTemplate: typeof prepareAfterEffectsTemplate;
};

const execFileAsync = promisify(execFile);

/** ffprobe's list of a file's stream types; empty when it cannot read one. */
export const probeStreamTypesWithFfprobe = async (file: string): Promise<string[]> => {
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "stream=codec_type", "-of", "json", file,
    ]);
    const streams = (JSON.parse(stdout) as { streams?: { codec_type?: unknown }[] }).streams ?? [];
    return streams.map((stream) => String(stream.codec_type));
  } catch {
    return [];
  }
};

const defaultDeps: AfterEffectsEngineDeps = {
  readConfig: () => readAfterEffectsConfig(),
  discover: discoverInstalledAerender,
  probeAudioDurationInSeconds,
  probeStreamTypes: probeStreamTypesWithFfprobe,
  spawn: nodeSpawn,
  publicDir: PUBLIC_DIR,
  prepareTemplate: prepareAfterEffectsTemplate,
};

/** Written beside its destination and renamed over it, so a reader never sees half a file. */
const writeAtomically = async (destination: string, content: string | null, copyFrom?: string): Promise<void> => {
  const temporary = `${destination}.tmp-${process.pid}`;
  let owned = false;
  try {
    if (copyFrom !== undefined) { await copyFile(copyFrom, temporary, constants.COPYFILE_FICLONE | constants.COPYFILE_EXCL); owned = true; }
    else {
      const file = await open(temporary, "wx", 0o600); owned = true;
      try { await file.writeFile(content ?? ""); } finally { await file.close(); }
    }
    await rename(temporary, destination);
  } finally { if (owned) await rm(temporary, {force:true}); }
};

const stageAssets = async (
  props: VisualizerProps,
  dir: string,
  publicDir: string,
): Promise<TemplateData["assets"]> => {
  const sources: Record<keyof typeof STAGED_ASSET_NAMES, string> = {
    cover: props.coverSrc,
    audio: props.audioSrc,
    waveformAudio: props.waveformAudioSrc ?? props.audioSrc,
    brandLogo: props.brandLogoSrc,
    brandBadge: props.brandBadgeSrc,
  };
  const staged = {} as Record<keyof typeof STAGED_ASSET_NAMES, string>;
  for (const [role, source] of Object.entries(sources) as [keyof typeof STAGED_ASSET_NAMES, string][]) {
    const destination = path.join(dir, `${STAGED_ASSET_NAMES[role]}${path.extname(source)}`);
    await writeAtomically(destination, null, path.join(publicDir, source));
    staged[role] = destination;
  }
  return staged;
};

const describeMissing = (missing: readonly string[]): string => {
  const parts = [
    ...(missing.some((name) => name.endsWith(".png")) ? ["cover"] : []),
    ...(missing.some((name) => name.endsWith(".wav")) ? ["audio"] : []),
  ];
  return parts.length > 1 ? `${parts.slice(0, -1).join("; ")}; or ${parts.at(-1)}` : parts.join("");
};

const renderFailed = (message: string): TrackError =>
  new TrackError(trackIssue("RENDER_FAILED", message));

export const createAfterEffectsRenderEngine = (
  overrides: Partial<AfterEffectsEngineDeps> = {},
): RenderEngine => {
  const deps = { ...defaultDeps, ...overrides };

  return {
    id: "after-effects",
    open: async (options = {}): Promise<RenderSession> => {
      const log = options.log ?? (() => {});
      // Installed first, then configured: the same order the registry's
      // probe and the CLI report problems in.
      const discovery = deps.discover();
      if (!discovery.found) {
        throw new TrackError(
          trackIssue("RENDERER_UNAVAILABLE", `The "after-effects" render engine is not available: ${describeAerenderNotFound(discovery)}`),
        );
      }
      const config = deps.readConfig();

      log(`After Effects: aerender ${discovery.path} (found via ${discovery.source}).`);
      log(`After Effects: project ${config.project}.`);
      // Read once: hashed as the template's version, and searched for the
      // staged files it must use (templateContract.mts).
      const projectBytes = await readFile(config.project);
      let baseHash = hashProject(projectBytes);
      let renderProject = config.project;
      let resolving: Promise<ResolvedVideo> | null = null;
      let resolvingActive = false;
      let closed = false;
      let cancelled = false;
      let uncertainPreparation = false;
      const preparationCancel = makeCancelSignal();
      options.cancelSignal?.(() => { cancelled = true; preparationCancel.cancel(); });

      let resolved: { composition: string; durationInFrames: number; fps: number } | null = null;
      let child: ReturnType<typeof nodeSpawn> | null = null;
      let childClosed: Promise<void> | null = null;
      let releaseStaging: WorkspaceLock | null = null;
      let releaseWorkspace: WorkspaceLock | null = null;
      const ownership = (changes: Parameters<WorkspaceLock["update"]>[0]) => {
        releaseWorkspace?.update(changes); releaseStaging?.update(changes);
      };

      return {
        // aerender reads the assets in place, through the sidecar's absolute paths.
        assetRoot: deps.publicDir,

        resolve: (props) => {
          if (resolvingActive || resolved || uncertainPreparation) {
            return Promise.reject(renderFailed("After Effects session already resolving, resolved or awaiting recovery."));
          }
          resolvingActive = true;
          const task = (async (): Promise<ResolvedVideo> => {
            if (closed || cancelled) throw renderFailed("After Effects preparation cancelled.");
            log("After Effects: Waiting for After Effects lock.");
            releaseStaging ??= acquireAfterEffectsStagingLock(config.dataFile);
            if (config.templatePreparation === "auto") {
              await mkdir(config.workingDirectory, { recursive: true, mode: 0o700 });
              releaseWorkspace ??= acquireAfterEffectsStagingLock(path.join(config.workingDirectory, "workspace.json"), ".toshi-ae-workspace.lock");
            }
            ownership({ trackIdentity: JSON.stringify([props.audioSrc, props.coverSrc]) });
            log("After Effects: serial execution; shared staging lock held until aerender stops.");
            const preset = renderPreset(props.presetId ?? DEFAULT_RENDER_PRESET_ID);
            const composition = config.compositions[preset.id] ?? config.composition;
            const seconds = await deps.probeAudioDurationInSeconds(path.join(deps.publicDir, props.audioSrc));
            const durationInFrames = secondsToFrames(seconds, preset.fps);

            // A template cannot swap a footage item's file per render, so this
            // track's images and audio are copied to fixed names beside the
            // sidecar; the template imports those files as footage and After
            // Effects reloads them when aerender opens it. The sidecar is what
            // create-toshi-template.jsx reads the track's text from.
            const staged = await stageAssets(props, path.dirname(config.dataFile), deps.publicDir);
            const data = buildTemplateData({
              props,
              preset,
              durationInFrames,
              resolveAsset: (relative) => path.join(deps.publicDir, relative),
            });
            await writeAtomically(config.dataFile, `${JSON.stringify({ ...data, assets: staged }, null, 2)}\n`);

            log(`After Effects: composition "${composition}", ${durationInFrames} frames @ ${preset.fps}fps.`);
            log(`After Effects: template data and assets staged in ${path.dirname(config.dataFile)}.`);
            // The template's text is written in when it is built (templateText),
            // so this is the text it must have been built with.
            const text = templateText(data.track);
            const marker = templateTextMarker(text);
            log(
              `After Effects: this track's text: Title "${text.Title}", Artist "${text.Artist}", ` +
                `Key BPM "${text["Key BPM"]}" (${marker}).`,
            );

            // Checked after staging, so the files a template needs are already
            // there to import when this says they are not being used.
            if (config.templatePreparation === "auto") {
              // Read under the staging lock; open() may have preceded a base edit.
              const baseBytes = await readFile(config.project);
              baseHash = hashProject(baseBytes);
              try {
                renderProject = await deps.prepareTemplate({
                  config, baseBytes, composition, marker, text,
                  trackIdentity: JSON.stringify([props.audioSrc, props.coverSrc]),
                  assets: Object.fromEntries(Object.entries(staged).map(([role, file]) =>
                    [STAGED_ASSET_NAMES[role as keyof typeof STAGED_ASSET_NAMES], file])),
                  cancelSignal: preparationCancel.cancelSignal, log, onOwnership: ownership,
                });
              } catch (error) {
                uncertainPreparation = error instanceof PreparationError && error.uncertain;
                throw error;
              }
            } else if (config.templateCheck) {
              const missing = missingTemplateFiles(projectBytes);
              if (missing.length > 0) {
                throw new TrackError(
                  trackIssue(
                    "RENDERER_NOT_CONFIGURED",
                    `The After Effects template ${path.basename(config.project)} does not use ${missing.join(", ")}, ` +
                      `so it would render without the track's ${describeMissing(missing)}. The files are staged in ` +
                      `${path.dirname(config.dataFile)}: build the template with adapters/after-effects/template/create-toshi-template.jsx ` +
                      `(After Effects: File > Scripts > Run Script File...) or import them by hand as the README describes, then save the project. ` +
                      `If your template really does not need them, set "templateCheck": false in after-effects.local.json.`,
                  ),
                );
              }
              log(`After Effects: template uses the staged cover and audio.`);
              const textStatus = templateTextStatus(projectBytes, marker);
              if (textStatus === "stale") {
                throw new TrackError(
                  trackIssue(
                    "RENDERER_NOT_CONFIGURED",
                    `The After Effects template ${path.basename(config.project)} was built with another track's title, artist and key: ` +
                      `the text is written into the template when it is built, and it does not match this track (${marker}). ` +
                      `This track's data is now staged in ${path.dirname(config.dataFile)}: in a new After Effects project, run ` +
                      `adapters/after-effects/template/create-toshi-template.jsx (File > Scripts > Run Script File...), choose that folder, ` +
                      `save the project over ${config.project}, and render again.`,
                  ),
                );
              }
              if (textStatus === "current") log(`After Effects: template text matches this track.`);
              else {
                log(
                  `After Effects: warning: the project carries no Toshi text marker, so its title, artist and key may not be this track's; ` +
                    `rebuild it with create-toshi-template.jsx to be sure.`,
                );
              }
              for (const warning of templateWarnings(projectBytes, composition)) {
                log(`After Effects: warning: ${warning}`);
              }
            }

            resolved = { composition, durationInFrames, fps: preset.fps };
            ownership({ phase: "ready", safeToDelete: true, preparedProject: renderProject, childPid: null });
            return {
              durationInFrames,
              fps: preset.fps,
              width: preset.width,
              height: preset.height,
              template: afterEffectsTemplateIdentity(config, preset.id, baseHash),
            };
          })().finally(() => { resolvingActive = false; });
          resolving = task;
          return task;
        },

        render: ({ outputPath, cancelSignal, onProgress }) => {
          if (!resolved || closed) {
            return Promise.reject(new Error("RenderSession.render() called before resolve()."));
          }
          const { composition, durationInFrames } = resolved;
          const target = path.join(path.dirname(outputPath), RENDER_FILE_NAME);
          const args = buildAerenderArgs({
            project: renderProject,
            composition,
            output: target,
            durationInFrames,
            outputModule: config.outputModule,
          });
          if (config.templatePreparation === "auto") log("After Effects: Rendering with After Effects.");
          log(`After Effects: rendering to ${outputPath}.`);

          return new Promise<void>((resolve, reject) => {
            const tail: string[] = [];
            let cancelled = false;
            let settled = false;
            const settle = (error: Error | null) => {
              if (settled) return;
              settled = true;
              if (error) reject(error);
              else resolve();
            };

            ownership({ phase: "rendering", safeToDelete: false, childPid: null });
            const running = deps.spawn(discovery.path, args, { stdio: ["ignore", "pipe", "pipe"] });
            child = running;
            childClosed = new Promise<void>((done) => running.once("close", () => done()));

            const read = (stream: NodeJS.ReadableStream | null) => {
              if (!stream) return;
              createInterface({ input: stream }).on("line", (line) => {
                const frame = parseAerenderProgressFrame(line);
                if (frame !== null) {
                  const rendered = Math.min(frame + 1, durationInFrames);
                  onProgress?.({
                    progress: rendered / durationInFrames,
                    renderedFrames: rendered,
                    encodedFrames: rendered,
                    stitchStage: "aerender",
                  });
                  return;
                }
                if (line.trim() === "") return;
                tail.push(line.trim());
                if (tail.length > TAIL_LINES) tail.shift();
              });
            };
            read(running.stdout);
            read(running.stderr);

            cancelSignal?.(() => {
              if (settled) return;
              cancelled = true;
              running.kill("SIGTERM");
              setTimeout(() => {
                if (!settled) running.kill("SIGKILL");
              }, KILL_GRACE_MS).unref();
            });

            running.on("error", (error) => {
              settle(renderFailed(`Could not start aerender at ${discovery.path}: ${error.message}`));
            });

            running.on("close", (code, signal) => {
              try { ownership({ phase: "rendered", safeToDelete: true, childPid: null }); }
              catch (error) { settle(renderFailed(`Could not record confirmed child shutdown: ${String(error)}`)); return; }
              if (cancelled) {
                settle(new Error("aerender got cancelled"));
                return;
              }
              const detail = tail.length > 0 ? ` Last output: ${tail.slice(-4).join(" | ")}` : "";
              if (code !== 0) {
                log(`After Effects: aerender failed (${signal ? `signal ${signal}` : `exit code ${code}`}).`);
                settle(
                  renderFailed(
                    `aerender ${signal ? `was stopped by ${signal}` : `exited with code ${code}`} rendering "${composition}".${detail}`,
                  ),
                );
                return;
              }

              if (!existsSync(target) || statSync(target).size === 0) {
                // aerender names the file after its output module's format, so a
                // QuickTime or image-sequence module leaves something else behind.
                const stem = path.parse(RENDER_FILE_NAME).name;
                const other = readdirSync(path.dirname(target)).find(
                  (name) => name.startsWith(stem) && name !== RENDER_FILE_NAME,
                );
                settle(
                  renderFailed(
                    other
                      ? `aerender wrote ${other}, but Toshi exports are MP4. Set "outputModule" in after-effects.local.json to an H.264 / MP4 output-module template.`
                      : `aerender finished without writing ${RENDER_FILE_NAME}.${detail}`,
                  ),
                );
                return;
              }

              // A silent or picture-less file is a failed render, never an
              // export: audio is part of every Toshi video.
              deps
                .probeStreamTypes(target)
                .then((streams) => {
                  const problems = renderedMediaProblems(streams);
                  if (problems.length > 0) {
                    throw renderFailed(
                      `aerender's video has ${problems.join(" and ")}. ` +
                        (problems.includes("no audio stream")
                          ? `Check that composition "${composition}" has a toshi-audio.wav layer that is switched on and lasts the whole track, and that the output module's Audio Output is On or Auto.`
                          : `Check the output module writes H.264 video.`),
                    );
                  }
                  return rename(target, outputPath);
                })
                .then(
                  () => settle(null),
                  (error: Error) =>
                    settle(error instanceof TrackError ? error : renderFailed(`Could not move aerender's output into place: ${error.message}`)),
                );
            });
            ownership({ childPid: running.pid ?? null });
          });
        },

        close: async () => {
          closed = true;
          preparationCancel.cancel();
          if (resolving) await resolving.catch(() => {});
          child?.kill("SIGKILL");
          if (childClosed !== null) await childClosed;
          child = null;
          if (!uncertainPreparation) {
            if (releaseWorkspace) {
              try {
                const result = prunePreparedCache(config, renderProject, releaseWorkspace.token);
                for (const error of result.failures) log(`After Effects: cleanup_failed: ${error.message}`);
                if (result.removed.length) log(`After Effects: cache retention removed ${result.removed.length} artifacts.`);
              } catch (error) { log(`After Effects: cleanup_failed: ${String(error)}`); }
              try { releaseWorkspace(); } finally { releaseStaging?.(); }
            }
            else releaseStaging?.();
          }
          else log("After Effects: staging lock retained because JSX completion is unconfirmed.");
          releaseStaging = null;
          releaseWorkspace = null;
        },
      };
    },
  };
};

export const afterEffectsRenderEngine = createAfterEffectsRenderEngine();
