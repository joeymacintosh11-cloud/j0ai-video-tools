import { createHash } from "node:crypto";

/** Revision of the exact bytes read, including external edits and formatting. */
export const metadataRevision = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex");
