import { existsSync, linkSync, renameSync, unlinkSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  createExportManifest,
  type ExportInputs,
} from "../tracks/exportManifest.ts";
import { withRenderTargetLock, type RenderTargetLock } from "./renderLock.ts";
import { trackOutputLocation } from "../tracks/trackLocations.ts";
import type { RenderPresetId } from "../../src/domain/video/renderPresets.ts";

/** Stage everything before replacing anything. A failed/cancelled producer
 * cannot touch the last successful pair. Publication has no await points;
 * rollback restores both files on a rename failure. A hard process/OS crash
 * between renames is detected by the output identity in the manifest. */
export const publishExport = async (
  slug: string,
  presetId: RenderPresetId,
  inputs: ExportInputs,
  produce: (stagedVideo: string) => Promise<void>,
  checkCancelled: () => void = () => {},
  lock?: RenderTargetLock,
): Promise<void> => {
  if (!lock) return withRenderTargetLock(slug, presetId, (owned) =>
    publishExport(slug, presetId, inputs, produce, checkCancelled, owned));
  if (lock.slug !== slug || lock.presetId !== presetId) throw new Error("Wrong publication lock target.");
  lock.assertOwned();
  const output = trackOutputLocation(slug, presetId);
  await mkdir(output.dir, { recursive: true });
  const staging = await mkdtemp(path.join(output.dir, ".render-"));
  const video = path.join(staging, "video.mp4");
  const manifest = path.join(staging, "manifest.json");
  let preserveRecoveryFiles = false;
  try {
    checkCancelled();
    await produce(video);
    checkCancelled();
    const record = createExportManifest(slug, presetId, inputs, video);
    await writeFile(manifest, `${JSON.stringify(record, null, 2)}\n`, {
      flag: "wx",
    });
    lock.commit(() => {
      checkCancelled();
      const oldVideo = path.join(staging, "previous.mp4");
      const oldManifest = path.join(staging, "previous.manifest.json");
      const hadVideo = existsSync(output.path);
      const hadManifest = existsSync(output.manifest);
      if (hadVideo) linkSync(output.path, oldVideo);
      if (hadManifest) linkSync(output.manifest, oldManifest);
      let videoPublished = false;
      try {
        lock.assertOwned();
        renameSync(video, output.path);
        videoPublished = true;
        lock.assertOwned();
        renameSync(manifest, output.manifest);
      } catch (error) {
        try {
          lock.assertOwned();
          if (videoPublished) {
            if (hadVideo) renameSync(oldVideo, output.path);
            else unlinkSync(output.path);
          }
          // Manifest rename is atomic: on failure the old manifest remains.
        } catch {
          preserveRecoveryFiles = true;
          throw new Error(
            `Export publication failed; recovery files kept at ${staging}: ${String(error)}`,
          );
        }
        throw error;
      }
    });
  } finally {
    if (!preserveRecoveryFiles)
      await rm(staging, { recursive: true, force: true });
  }
};
