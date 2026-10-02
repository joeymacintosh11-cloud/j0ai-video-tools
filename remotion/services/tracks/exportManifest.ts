import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { BeatVisualizerProps } from "../../src/BeatVisualizer/BeatVisualizer.ts";
import {
  EXPORT_MANIFEST_VERSION,
  VISUALIZER_VERSION,
  type StaleReason,
} from "../../core/domain/video/exportFreshness.ts";
import {
  renderPreset,
  type RenderPresetId,
} from "../../core/domain/video/renderPresets.ts";
import { PUBLIC_DIR } from "./trackLocations.ts";

export type ExportInputs = Readonly<
  Record<"metadata" | "cover" | "audio" | "preset" | "visualizer", string>
>;
export type ExportManifest = {
  readonly schemaVersion: typeof EXPORT_MANIFEST_VERSION;
  readonly slug: string;
  readonly presetId: RenderPresetId;
  readonly renderedAt: string;
  readonly inputFingerprint: string;
  readonly inputs: ExportInputs;
  readonly output: {
    readonly bytes: number;
    readonly mtimeMs: number;
    readonly ino: number;
  };
};
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const inputFingerprint = (inputs: ExportInputs): string =>
  hash([
    inputs.metadata,
    inputs.cover,
    inputs.audio,
    inputs.preset,
    inputs.visualizer,
  ]);

// Bounded, process-local content cache. Stat every time; hash in 1 MiB chunks
// only when identity changes. No full WAV buffers and no persistent state.
const hashes = new Map<string, { identity: string; hash: string }>();
export const fileContentHash = (file: string): string => {
  const stats = statSync(file);
  const identity = [
    stats.dev,
    stats.ino,
    stats.size,
    stats.mtimeMs,
    stats.ctimeMs,
  ].join(":");
  const cached = hashes.get(file);
  if (cached?.identity === identity) return cached.hash;
  const fd = openSync(file, "r");
  try {
    const digest = createHash("sha256");
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let bytes: number;
    while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0)
      digest.update(buffer.subarray(0, bytes));
    const after = fstatSync(fd);
    if (
      [after.dev, after.ino, after.size, after.mtimeMs, after.ctimeMs].join(
        ":",
      ) !== identity
    ) {
      throw new Error(`Input changed while fingerprinting: ${file}`);
    }
    const result = digest.digest("hex");
    hashes.delete(file);
    hashes.set(file, { identity, hash: result });
    if (hashes.size > 256) hashes.delete(hashes.keys().next().value!);
    return result;
  } finally {
    closeSync(fd);
  }
};

/** publicRoot is the immutable bundle copy when recording a real render. */
export const fingerprintInputs = (
  props: BeatVisualizerProps,
  presetId: RenderPresetId,
  publicRoot = PUBLIC_DIR,
): ExportInputs => {
  const preset = renderPreset(presetId);
  return {
    metadata: hash([
      props.title,
      props.artist,
      props.musicalKey,
      props.bpm,
      props.subtitle ?? "",
    ]),
    cover: fileContentHash(path.join(publicRoot, props.coverSrc)),
    audio: fileContentHash(path.join(publicRoot, props.audioSrc)),
    preset: hash([
      preset.id,
      preset.width,
      preset.height,
      preset.fps,
      preset.layout,
      preset.aspectRatio,
    ]),
    visualizer: hash([
      VISUALIZER_VERSION,
      fileContentHash(path.join(publicRoot, props.brandLogoSrc)),
      fileContentHash(path.join(publicRoot, props.brandBadgeSrc)),
    ]),
  };
};

export const outputIdentity = (file: string): ExportManifest["output"] => {
  const stats = statSync(file);
  if (!stats.isFile() || stats.size === 0)
    throw new Error("Rendered output is missing or empty.");
  return { bytes: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino };
};

export const createExportManifest = (
  slug: string,
  presetId: RenderPresetId,
  inputs: ExportInputs,
  output: string,
): ExportManifest => ({
  schemaVersion: EXPORT_MANIFEST_VERSION,
  slug,
  presetId,
  renderedAt: new Date().toISOString(),
  inputs,
  inputFingerprint: inputFingerprint(inputs),
  output: outputIdentity(output),
});

/** Invalid/missing manifests never make an existing MP4 disappear. */
export const readExportManifest = (
  file: string,
  slug: string,
  presetId: RenderPresetId,
): { manifest: ExportManifest | null; reason: StaleReason | null } => {
  try {
    const value = JSON.parse(readFileSync(file, "utf8")) as ExportManifest;
    const keys = [
      "metadata",
      "cover",
      "audio",
      "preset",
      "visualizer",
    ] as const;
    if (
      value?.schemaVersion !== EXPORT_MANIFEST_VERSION ||
      value.slug !== slug ||
      value.presetId !== presetId ||
      !Number.isFinite(Date.parse(value.renderedAt)) ||
      !keys.every((key) => /^[a-f0-9]{64}$/.test(value.inputs?.[key])) ||
      value.inputFingerprint !== inputFingerprint(value.inputs) ||
      !(value.output?.bytes > 0) ||
      !Number.isFinite(value.output.mtimeMs) ||
      !Number.isFinite(value.output.ino)
    ) {
      return { manifest: null, reason: "manifest_invalid" };
    }
    return { manifest: value, reason: null };
  } catch (error) {
    return {
      manifest: null,
      reason:
        (error as NodeJS.ErrnoException).code === "ENOENT"
          ? "manifest_missing"
          : "manifest_invalid",
    };
  }
};

export const compareInputs = (
  before: ExportInputs,
  now: ExportInputs,
): StaleReason[] =>
  (Object.keys(now) as (keyof ExportInputs)[])
    .filter((key) => before[key] !== now[key])
    .map((key) => `${key}_changed` as StaleReason);
