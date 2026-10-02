import {
  listRenderLocks,
  releaseRenderTargetLock,
  RENDER_LOCK_DIR,
} from "../services/render/renderLock.ts";
import { TrackError, trackIssue } from "../core/domain/tracks/errors.ts";
import { assertRenderPresetId } from "../core/domain/video/renderPresets.ts";
import { assertValidSlug } from "../core/domain/tracks/slug.ts";
import { runCli } from "./cli.ts";

/**
 * Inspects and clears render target locks.
 *
 * A lock whose owning process is gone is reclaimed automatically by the next
 * render, so this is only needed for the cases that cannot be proved dead: a
 * lock written by another machine, or one whose metadata is unreadable. Those
 * are never stolen automatically, because guessing wrong would mean two
 * processes publishing the same export.
 *
 * Release takes a slug and a format, never a path, so it can only ever remove
 * a file this project created.
 */

const printUsage = () => {
  console.error(
    [
      "Usage: npm run render-locks                                 List current locks",
      "       npm run render-locks -- --release <slug> <preset>    Clear one lock",
      "",
      "Release only after confirming nothing is rendering that target —",
      "check `ps` for render-worker or render-track processes first.",
    ].join("\n"),
  );
};

runCli("inspecting render locks", () => {
  const argv = process.argv.slice(2);

  if (argv.includes("--help")) {
    printUsage();
    return;
  }

  const releaseIndex = argv.indexOf("--release");

  if (releaseIndex === -1) {
    const locks = listRenderLocks();

    if (locks.length === 0) {
      console.log(`✓ No render locks held. (${RENDER_LOCK_DIR})`);
      return;
    }

    console.log(`${locks.length} render lock(s) in ${RENDER_LOCK_DIR}:\n`);

    for (const lock of locks) {
      const owner = lock.owner
        ? `pid ${lock.owner.pid} on ${lock.owner.hostname}` +
          `${lock.owner.jobId ? `, job ${lock.owner.jobId}` : ""}` +
          `, since ${lock.owner.createdAt}`
        : "unreadable lock metadata";
      const note = lock.owner
        ? lock.abandoned
          ? " — owner is gone; the next render reclaims this automatically"
          : " — owner appears to be running"
        : " — will not be reclaimed automatically; release it explicitly";

      console.log(`  ${lock.slug} / ${lock.presetId}`);
      console.log(`    ${owner}${note}`);
    }

    return;
  }

  const slug = assertValidSlug(argv[releaseIndex + 1]);
  const presetId = assertRenderPresetId(argv[releaseIndex + 2]);

  if (argv[releaseIndex + 2] === undefined) {
    throw new TrackError(
      trackIssue(
        "INVALID_REQUEST",
        "--release needs both a track slug and a format, e.g. --release ghetto-geek youtube-16x9.",
      ),
    );
  }

  console.log(
    releaseRenderTargetLock(slug, presetId)
      ? `✓ Released the render lock for ${slug} / ${presetId}.`
      : `✓ No render lock was held for ${slug} / ${presetId}.`,
  );
});
