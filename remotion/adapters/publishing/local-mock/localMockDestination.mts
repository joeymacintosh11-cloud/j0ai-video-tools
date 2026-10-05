import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { DestinationCapabilities } from "../../../core/domain/publishing/destinations.ts";
import type {
  PreparedPublication,
  PublishContext,
  PublishDestination,
  PublishDestinationDescriptor,
  PublishRequest,
  PublishResult,
} from "../../../core/ports/publishDestination.ts";

/**
 * A deterministic local publishing destination, for development and tests.
 *
 * It proves the whole publishing path without a network: prepare() copies the
 * pinned export into its own workspace (never touching the original), and
 * publish() turns that staged copy into a "publication" folder named by a
 * stable id derived from the attempt's idempotency key:
 *
 *   <workspace>/publications/<publicationId>/video.mp4
 *   <workspace>/publications/<publicationId>/publication.json
 *
 * Because the id is a function of the idempotency key and the folder appears
 * by an atomic rename, repeating an attempt returns the same publication
 * instead of creating a second one — so this adapter, unlike a real platform
 * until proven, declares idempotentPublish. recover() answers from the same
 * folder, so it can prove both "published" and "not published".
 *
 * Failure, uncertainty and slowness are explicit fixtures (`behavior`), never
 * inferred from content.
 */

export type LocalMockBehavior =
  /** Publish and report it. */
  | "success"
  /** Report a definite failure; nothing is written. */
  | "failure"
  /** Publish, then lose the answer: reports uncertain (recover finds it). */
  | "uncertain"
  /** Throw before publishing (recover proves nothing was published). */
  | "throw"
  /** Publish, but answer with an id that cannot be a valid receipt. */
  | "invalid-receipt";

export const LOCAL_MOCK_BEHAVIORS: readonly LocalMockBehavior[] = ["success", "failure", "uncertain", "throw", "invalid-receipt"];

export type LocalMockOptions = {
  readonly descriptor: PublishDestinationDescriptor;
  /** Absolute directory this destination owns. Asked per call. */
  readonly workspace: () => string;
  readonly behavior?: () => LocalMockBehavior;
  /** Simulated publish duration, during which cancel is honoured. */
  readonly delayMs?: () => number;
  readonly now?: () => string;
};

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const fileSha256 = (file: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    createReadStream(file)
      .on("data", (chunk) => hash.update(chunk))
      .on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });

const SAFE = /^[a-z0-9_]+$/;

export const MOCK_CAPABILITIES_BASE: Omit<DestinationCapabilities, "formats"> = {
  metadata: {
    titleMaxLength: 100,
    descriptionMaxLength: 5000,
    maxTags: 30,
    tagMaxLength: 50,
    visibilities: ["public", "unlisted", "private"],
  },
  thumbnail: true,
  scheduling: false,
  cancel: true,
  recover: true,
  idempotentPublish: true,
  accounts: true,
  network: false,
};

type Staged = { readonly dir: string; readonly video: string; readonly sha256: string; readonly bytes: number };

type PublicationRecord = {
  readonly publicationId: string;
  readonly idempotencyKey: string;
  readonly jobId: string;
  readonly attemptId: string;
  readonly accountId: string | null;
  readonly publishedAt: string;
  readonly contentSha256: string;
  readonly source: PublishRequest["source"];
  readonly metadata: PublishRequest["metadata"];
  readonly mode: PublishRequest["mode"];
};

export const createLocalMockDestination = (options: LocalMockOptions): PublishDestination => {
  const { id } = options.descriptor;
  const now = options.now ?? (() => new Date().toISOString());
  const behavior = options.behavior ?? (() => "success" as const);
  const publicationsDir = () => path.join(options.workspace(), "publications");
  const publicationIdFor = (accountId: string | null, idempotencyKey: string) =>
    `mock-${sha256(`${id}\u0000${accountId ?? ""}\u0000${idempotencyKey}`).slice(0, 20)}`;
  const urlFor = (publicationId: string) => `mock://${id}/${publicationId}`;

  const readRecord = async (publicationId: string): Promise<PublicationRecord | null> => {
    try {
      return JSON.parse(await readFile(path.join(publicationsDir(), publicationId, "publication.json"), "utf8")) as PublicationRecord;
    } catch {
      return null;
    }
  };

  const prepare = async (request: PublishRequest): Promise<PreparedPublication> => {
    if (!SAFE.test(request.attemptId)) throw new Error("Unexpected attempt id.");
    const stagingRoot = path.join(options.workspace(), "staging");
    await mkdir(stagingRoot, { recursive: true });
    const dir = await mkdtemp(path.join(stagingRoot, `${request.attemptId}-`));
    const dispose = () => rm(dir, { recursive: true, force: true });
    try {
      const video = path.join(dir, "video.mp4");
      // A copy, never a move or link: the original export is not this adapter's.
      await copyFile(request.sourceFile, video, constants.COPYFILE_EXCL);
      const bytes = (await stat(video)).size;
      if (bytes !== request.source.output.bytes) throw new Error(`Staged ${bytes} bytes; the pinned export has ${request.source.output.bytes}.`);
      const staged: Staged = { dir, video, sha256: await fileSha256(video), bytes };
      return { request, state: staged, dispose };
    } catch (error) {
      await dispose();
      throw error;
    }
  };

  const publish = async (prepared: PreparedPublication, context: PublishContext): Promise<PublishResult> => {
    const { request } = prepared;
    const staged = prepared.state as Staged;
    let cancelled = false;
    context.cancelSignal(() => {
      cancelled = true;
    });
    const wait = options.delayMs?.() ?? 0;
    for (let waited = 0; waited < wait && !cancelled; waited += 10) await delay(10);
    if (cancelled) return { outcome: "cancelled" };

    const mode = behavior();
    if (mode === "failure") return { outcome: "failed", message: "The local mock destination was set to fail (simulated rejection)." };
    if (mode === "throw") throw new Error("Simulated adapter crash before publishing.");

    const publicationId = publicationIdFor(request.accountId, request.idempotencyKey);
    const existing = await readRecord(publicationId);
    if (existing === null) {
      const publishedAt = now();
      await mkdir(publicationsDir(), { recursive: true });
      const temp = await mkdtemp(path.join(publicationsDir(), ".incoming-"));
      try {
        await rename(staged.video, path.join(temp, "video.mp4"));
        const record: PublicationRecord = {
          publicationId,
          idempotencyKey: request.idempotencyKey,
          jobId: request.jobId,
          attemptId: request.attemptId,
          accountId: request.accountId,
          publishedAt,
          contentSha256: staged.sha256,
          source: request.source,
          metadata: request.metadata,
          mode: request.mode,
        };
        await writeFile(path.join(temp, "publication.json"), `${JSON.stringify(record, null, 2)}\n`, { flag: "wx" });
        // Appears whole or not at all; a second attempt with this key loses the race and reuses it.
        await rename(temp, path.join(publicationsDir(), publicationId)).catch(async (error: NodeJS.ErrnoException) => {
          if ((await readRecord(publicationId))?.idempotencyKey !== request.idempotencyKey) throw error;
        });
      } finally {
        await rm(temp, { recursive: true, force: true });
      }
      context.log(`Published locally as ${publicationId}.`);
    } else if (existing.idempotencyKey !== request.idempotencyKey) {
      return { outcome: "uncertain", message: `Publication ${publicationId} exists for a different attempt.`, publicationId };
    } else {
      context.log(`Attempt already published as ${publicationId}; reusing it.`);
    }

    const record = (await readRecord(publicationId))!;
    if (mode === "uncertain")
      return { outcome: "uncertain", message: "The local mock destination dropped its response (simulated).", publicationId: null };
    if (mode === "invalid-receipt")
      return { outcome: "published", publicationId: "not a valid id!", url: "https://user:pw@example.invalid/", publishedAt: record.publishedAt };
    return { outcome: "published", publicationId, url: urlFor(publicationId), publishedAt: record.publishedAt };
  };

  return {
    id,
    validate: (request) =>
      request.metadata.title.trim().toLowerCase() === "untitled"
        ? [{ reason: "publication_metadata_invalid", field: "title", message: `${options.descriptor.displayName} refuses the placeholder title "Untitled".` }]
        : [],
    prepare,
    publish,
    inspect: async (publicationId) => {
      if (!/^mock-[a-f0-9]{20}$/.test(publicationId)) return null;
      const record = await readRecord(publicationId);
      return record === null ? null : { publicationId, state: "published", url: urlFor(publicationId) };
    },
    recover: async (request) => {
      const publicationId = publicationIdFor(request.accountId, request.idempotencyKey);
      const record = await readRecord(publicationId);
      return record !== null && record.idempotencyKey === request.idempotencyKey
        ? { outcome: "published", publicationId, url: urlFor(publicationId), publishedAt: record.publishedAt }
        : { outcome: "not_published" };
    },
  };
};
