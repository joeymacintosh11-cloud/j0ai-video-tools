import { existsSync } from "node:fs";
import { createWriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";
import { once } from "node:events";
import { TrackError, trackIssue } from "../../src/domain/tracks/errors.ts";
import {
  publicLabel,
  trackAssetPaths,
} from "../../src/domain/tracks/paths.ts";
import { assertValidSlug } from "../../src/domain/tracks/slug.ts";
import { trackLocations } from "./trackLocations.ts";

/**
 * Writes an uploaded cover or beat into an existing track folder.
 *
 * Two properties matter most here:
 *
 *  - **The destination is never derived from client input.** The caller picks
 *    one of exactly two kinds, and the absolute path comes from
 *    trackLocations(slug) — the same resolver everything else uses. No filename,
 *    extension or path from the request ever reaches the filesystem, so there is
 *    nothing to traverse with.
 *  - **The body is streamed, never buffered.** A beat can be tens of megabytes;
 *    it goes to a temp file and is renamed into place, so a failed or oversized
 *    upload cannot leave a half-written cover.png or beat.wav behind.
 */

export type TrackAssetKind = "cover" | "beat";

export type UploadTrackAssetResult = {
  readonly slug: string;
  readonly kind: TrackAssetKind;
  /** public/-relative label for the file that was written. */
  readonly path: string;
  readonly bytes: number;
  /** True when this upload replaced an existing file. */
  readonly replaced: boolean;
};

type AssetRule = {
  readonly label: string;
  readonly maxBytes: number;
  readonly contentTypes: readonly string[];
  /** Minimum bytes needed before the format can be judged. */
  readonly headBytes: number;
  readonly looksValid: (head: Buffer) => boolean;
  readonly expected: string;
};

const MB = 1024 * 1024;

const RULES: Record<TrackAssetKind, AssetRule> = {
  cover: {
    label: "cover.png",
    maxBytes: 25 * MB,
    contentTypes: ["image/png"],
    headBytes: 8,
    // PNG signature.
    looksValid: (head) =>
      head.length >= 8 &&
      head[0] === 0x89 &&
      head.subarray(1, 4).toString("latin1") === "PNG" &&
      head[4] === 0x0d &&
      head[5] === 0x0a &&
      head[6] === 0x1a &&
      head[7] === 0x0a,
    expected: "a PNG image",
  },
  beat: {
    label: "beat.wav",
    // Roughly 23 minutes of 24-bit/48kHz stereo, well past any real beat.
    maxBytes: 400 * MB,
    contentTypes: ["audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave"],
    headBytes: 12,
    // RIFF....WAVE container header.
    looksValid: (head) =>
      head.length >= 12 &&
      head.subarray(0, 4).toString("latin1") === "RIFF" &&
      head.subarray(8, 12).toString("latin1") === "WAVE",
    expected: "a WAV audio file",
  },
};

const describeBytes = (bytes: number): string =>
  bytes >= MB
    ? `${(bytes / MB).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

export type UploadTrackAssetOptions = {
  readonly slug: string;
  readonly kind: TrackAssetKind;
  readonly body: AsyncIterable<Uint8Array>;
  /** Request content-type, if any; checked before the format signature. */
  readonly contentType?: string;
};

export const uploadTrackAsset = async ({
  slug: slugInput,
  kind,
  body,
  contentType,
}: UploadTrackAssetOptions): Promise<UploadTrackAssetResult> => {
  const slug = assertValidSlug(slugInput);
  const rule = RULES[kind];
  const locations = trackLocations(slug);

  // Uploads only ever land in a track that already exists. Creating the folder
  // here would let an upload conjure a track the rest of the system never
  // scaffolded.
  if (!existsSync(locations.trackDir)) {
    throw new TrackError(
      trackIssue(
        "TRACK_NOT_FOUND",
        `Track "${slug}" not found. Create it first, then upload its files.`,
        `public/tracks/${slug}/`,
      ),
    );
  }

  const destination = kind === "cover" ? locations.cover : locations.beat;
  const target = publicLabel(
    kind === "cover" ? trackAssetPaths(slug).cover : trackAssetPaths(slug).beat,
  );

  const mediaType = contentType?.split(";")[0]?.trim().toLowerCase();
  if (mediaType !== undefined && mediaType.length > 0) {
    if (!rule.contentTypes.includes(mediaType)) {
      throw new TrackError(
        trackIssue(
          "UPLOAD_INVALID",
          `${rule.label} must be ${rule.expected}. Received content-type "${mediaType}".`,
          target,
        ),
      );
    }
  }

  const replaced = existsSync(destination);
  const tempPath = `${destination}.tmp-${process.pid}`;
  const handle = createWriteStream(tempPath);

  let total = 0;
  let head = Buffer.alloc(0);
  let headChecked = false;

  const abort = async () => {
    handle.destroy();
    await unlink(tempPath).catch(() => undefined);
  };

  try {
    for await (const chunk of body) {
      const buffer = Buffer.from(chunk);
      total += buffer.length;

      if (total > rule.maxBytes) {
        throw new TrackError(
          trackIssue(
            "UPLOAD_TOO_LARGE",
            `${rule.label} may be at most ${describeBytes(rule.maxBytes)}.`,
            target,
          ),
        );
      }

      // Judge the format as soon as enough bytes have arrived, so a wrong file
      // is rejected immediately instead of after a long transfer.
      if (!headChecked) {
        head = Buffer.concat([head, buffer]);

        if (head.length >= rule.headBytes) {
          headChecked = true;

          if (!rule.looksValid(head)) {
            throw new TrackError(
              trackIssue(
                "UPLOAD_INVALID",
                `That file does not look like ${rule.expected}, so it was not saved as ${rule.label}.`,
                target,
              ),
            );
          }
        }
      }

      if (!handle.write(buffer)) {
        await once(handle, "drain");
      }
    }

    if (total === 0) {
      throw new TrackError(
        trackIssue(
          "UPLOAD_INVALID",
          `No data was uploaded for ${rule.label}.`,
          target,
        ),
      );
    }

    if (!headChecked) {
      throw new TrackError(
        trackIssue(
          "UPLOAD_INVALID",
          `That file is too short to be ${rule.expected}.`,
          target,
        ),
      );
    }

    handle.end();
    await once(handle, "finish");
  } catch (error) {
    await abort();

    if (error instanceof TrackError) {
      throw error;
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new TrackError(
      trackIssue("UPLOAD_FAILED", `Could not save ${target}: ${reason}`, target),
    );
  }

  try {
    await rename(tempPath, destination);
  } catch (error) {
    await unlink(tempPath).catch(() => undefined);
    const reason = error instanceof Error ? error.message : String(error);
    throw new TrackError(
      trackIssue("UPLOAD_FAILED", `Could not save ${target}: ${reason}`, target),
    );
  }

  // Replacing beat.wav makes analysis.wav stale by mtime, which prepareTrack
  // already detects and regenerates — nothing to invalidate by hand.
  return { slug, kind, path: target, bytes: total, replaced };
};
