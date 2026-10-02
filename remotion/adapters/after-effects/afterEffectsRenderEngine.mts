import { spawn as nodeSpawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readdirSync, statSync } from "node:fs";
import { rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { secondsToFrames } from "../../core/domain/video/compositionConfig.ts";
import { DEFAULT_RENDER_PRESET_ID, renderPreset } from "../../core/domain/video/renderPresets.ts";
import { buildTemplateData } from "../../core/domain/video/templateData.ts";
import type { RenderEngine, RenderSession } from "../../core/ports/renderEngine.ts";
import { probeAudioDurationInSeconds } from "../../services/tracks/audioDuration.ts";
import { buildAerenderArgs, parseAerenderProgressFrame } from "./aerenderCommand.mts";
import {
  describeAerenderNotFound,
  discoverInstalledAerender,
  type AerenderDiscovery,
} from "./aerenderDiscovery.mts";
import { readAfterEffectsConfig, type AfterEffectsConfig } from "./afterEffectsConfig.mts";

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
 *             from the track's audio, and writes the template-data sidecar
 *             (core/domain/video/templateData.ts) to the configured
 *             dataFile, which the project imports as JSON footage.
 *  render()   runs aerender for exactly those frames into a sibling of the
 *             staging path, reports its PROGRESS lines, and moves the file
 *             into place. A non-zero exit, a missing file or an output
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
  readonly spawn: typeof nodeSpawn;
  readonly publicDir: string;
};

const defaultDeps: AfterEffectsEngineDeps = {
  readConfig: () => readAfterEffectsConfig(),
  discover: discoverInstalledAerender,
  probeAudioDurationInSeconds,
  spawn: nodeSpawn,
  publicDir: PUBLIC_DIR,
};

/** A content hash of the project, so editing the template stales its exports. */
const projectVersion = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(`aep-sha256:${hash.digest("hex").slice(0, 16)}`));
  });

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
      const version = await projectVersion(config.project);

      let resolved: { composition: string; durationInFrames: number; fps: number } | null = null;
      let child: ReturnType<typeof nodeSpawn> | null = null;

      return {
        // aerender reads the assets in place, through the sidecar's absolute paths.
        assetRoot: deps.publicDir,

        resolve: async (props) => {
          const preset = renderPreset(props.presetId ?? DEFAULT_RENDER_PRESET_ID);
          const composition = config.compositions[preset.id] ?? config.composition;
          const seconds = await deps.probeAudioDurationInSeconds(path.join(deps.publicDir, props.audioSrc));
          const durationInFrames = secondsToFrames(seconds, preset.fps);

          const data = buildTemplateData({
            props,
            preset,
            durationInFrames,
            resolveAsset: (relative) => path.join(deps.publicDir, relative),
          });
          // Written whole and renamed into place, so the project never reads half a file.
          const temporary = `${config.dataFile}.tmp-${process.pid}`;
          await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`);
          await rename(temporary, config.dataFile);

          log(`After Effects: composition "${composition}", ${durationInFrames} frames @ ${preset.fps}fps.`);
          log(`After Effects: template data written to ${config.dataFile}.`);

          resolved = { composition, durationInFrames, fps: preset.fps };
          return {
            durationInFrames,
            fps: preset.fps,
            width: preset.width,
            height: preset.height,
            template: { composition, version },
          };
        },

        render: ({ outputPath, cancelSignal, onProgress }) => {
          if (!resolved) {
            return Promise.reject(new Error("RenderSession.render() called before resolve()."));
          }
          const { composition, durationInFrames } = resolved;
          const target = path.join(path.dirname(outputPath), RENDER_FILE_NAME);
          const args = buildAerenderArgs({
            project: config.project,
            composition,
            output: target,
            durationInFrames,
            outputModule: config.outputModule,
          });
          log(`After Effects: rendering to ${outputPath}.`);

          return new Promise<void>((resolve, reject) => {
            const tail: string[] = [];
            let cancelled = false;
            let settled = false;
            const settle = (error: Error | null) => {
              if (settled) return;
              settled = true;
              child = null;
              if (error) reject(error);
              else resolve();
            };

            const running = deps.spawn(discovery.path, args, { stdio: ["ignore", "pipe", "pipe"] });
            child = running;

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

              rename(target, outputPath).then(
                () => settle(null),
                (error: Error) => settle(renderFailed(`Could not move aerender's output into place: ${error.message}`)),
              );
            });
          });
        },

        close: async () => {
          child?.kill("SIGKILL");
          child = null;
        },
      };
    },
  };
};

export const afterEffectsRenderEngine = createAfterEffectsRenderEngine();
