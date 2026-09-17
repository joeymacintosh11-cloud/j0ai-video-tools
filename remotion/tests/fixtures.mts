import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import type { TestContext } from "node:test";
import { trackLocations } from "../services/tracks/trackLocations.ts";

export const fixture = async (t: TestContext) => {
  const slug = `regression-${randomUUID()}`;
  const locations = trackLocations(slug);
  await mkdir(locations.trackDir);
  t.after(() => rm(locations.trackDir, { recursive: true, force: true }));
  await writeFile(
    locations.metadata,
    JSON.stringify({
      title: "Fixture",
      artist: "Toshi",
      key: "F Minor",
      bpm: 100,
    }),
  );
  return { slug, ...locations };
};
export const tempFiles = async (directory: string) =>
  (await readdir(directory)).filter((name) => name.includes(".tmp-"));
