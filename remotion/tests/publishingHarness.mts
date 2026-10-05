import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import type { DestinationCapabilities } from "../core/domain/publishing/destinations.ts";
import type { PublicationMetadata } from "../core/domain/publishing/publicationMetadata.ts";
import type { RendererId } from "../core/domain/video/renderers.ts";
import type { RenderPresetId } from "../core/domain/video/renderPresets.ts";
import type { PublishDestinationDescriptor } from "../core/ports/publishDestination.ts";
import {
  createPublishDestinationRegistry,
  type DestinationConfiguration,
} from "../core/ports/publishDestinationRegistry.ts";
import {
  createLocalMockDestination,
  MOCK_CAPABILITIES_BASE,
  type LocalMockBehavior,
} from "../adapters/publishing/local-mock/localMockDestination.mts";
import { publishExport } from "../services/render/publishExport.ts";
import { buildTrackProps } from "../services/tracks/buildTrackProps.ts";
import { fingerprintInputs } from "../services/tracks/exportManifest.ts";
import { inspectTrack } from "../services/tracks/inspectTrack.ts";
import { trackOutputLocation } from "../services/tracks/trackLocations.ts";
import { createPublishingService } from "../services/publishing/publishing.ts";
import { destinationWorkspace } from "../services/publishing/publishingStore.ts";
import { fixture } from "./fixtures.mts";
import { syntheticTemplate } from "./syntheticTemplate.mts";

/**
 * Synthetic publishing fixtures: a throwaway track with real published
 * exports (synthetic bytes, real manifests), an isolated publishing root and
 * settings file, and a registry of local mock destinations whose behaviour
 * each test controls. No network, no real track or export is touched.
 */

export const metadata = (overrides: Partial<PublicationMetadata> = {}): PublicationMetadata => ({
  title: "Fixture — Toshi",
  description: "A synthetic publication.",
  tags: ["toshi", "beats"],
  visibility: "private",
  scheduledAt: null,
  thumbnail: null,
  ...overrides,
});

export const isolatePublishing = async (t: TestContext) => {
  const dir = realpathSync(await mkdtemp(path.join(tmpdir(), "toshi-publishing-")));
  const saved = {
    root: process.env.TOSHI_PUBLISHING_DIR,
    settings: process.env.TOSHI_PUBLISHING_SETTINGS,
  };
  process.env.TOSHI_PUBLISHING_DIR = path.join(dir, "publishing");
  process.env.TOSHI_PUBLISHING_SETTINGS = path.join(dir, "publishing.local.json");
  t.after(async () => {
    if (saved.root === undefined) delete process.env.TOSHI_PUBLISHING_DIR;
    else process.env.TOSHI_PUBLISHING_DIR = saved.root;
    if (saved.settings === undefined) delete process.env.TOSHI_PUBLISHING_SETTINGS;
    else process.env.TOSHI_PUBLISHING_SETTINGS = saved.settings;
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    root: process.env.TOSHI_PUBLISHING_DIR,
    settingsFile: process.env.TOSHI_PUBLISHING_SETTINGS,
    writeSettings: (value: unknown) => writeFile(process.env.TOSHI_PUBLISHING_SETTINGS!, JSON.stringify(value)),
  };
};

const capabilities = (formats: DestinationCapabilities["formats"]): DestinationCapabilities => ({ ...MOCK_CAPABILITIES_BASE, formats });

export const ALL_FORMATS: PublishDestinationDescriptor = {
  id: "test-mock",
  displayName: "Test mock",
  capabilities: capabilities([
    { presetId: "youtube-16x9", mode: "video" },
    { presetId: "vertical-9x16", mode: "short" },
    { presetId: "square-1x1", mode: "post" },
  ]),
};

export const LANDSCAPE_ONLY: PublishDestinationDescriptor = {
  id: "test-landscape",
  displayName: "Test landscape",
  capabilities: capabilities([{ presetId: "youtube-16x9", mode: "video" }]),
};

export const UNCONFIGURED: PublishDestinationDescriptor = {
  id: "test-unconfigured",
  displayName: "Test unconfigured",
  capabilities: capabilities([{ presetId: "youtube-16x9", mode: "video" }]),
};

export const MISSING: PublishDestinationDescriptor = {
  id: "test-missing",
  displayName: "Test missing dependency",
  capabilities: capabilities([{ presetId: "youtube-16x9", mode: "video" }]),
};

/** A registry of mock destinations plus knobs: behaviour and delay per call. */
export const mockRegistry = () => {
  const knobs = { behavior: "success" as LocalMockBehavior, delayMs: 0, loads: 0 };
  const mock = (descriptor: PublishDestinationDescriptor) => ({
    descriptor,
    configured: (): DestinationConfiguration => ({ problem: null, accountId: "tester" }),
    load: async () => {
      knobs.loads++;
      return createLocalMockDestination({
        descriptor,
        workspace: () => destinationWorkspace(descriptor.id),
        behavior: () => knobs.behavior,
        delayMs: () => knobs.delayMs,
      });
    },
  });
  const registry = createPublishDestinationRegistry([
    mock(ALL_FORMATS),
    mock(LANDSCAPE_ONLY),
    { ...mock(UNCONFIGURED), configured: () => ({ problem: "Add an account in publishing.local.json.", accountId: null }) },
    { ...mock(MISSING), probe: () => "The test SDK is not installed." },
  ]);
  return { registry, knobs };
};

/** A track with synthetic but genuinely published exports, per renderer. */
export const publishingTrack = async (t: TestContext, extra: Record<string, unknown> = {}) => {
  const template = await syntheticTemplate(t);
  const f = await fixture(t, { exportPresets: ["youtube-16x9", "vertical-9x16", "square-1x1"], ...extra });
  await writeFile(f.cover, "synthetic cover");
  await writeFile(f.beat, "synthetic audio");
  t.after(() => rm(f.outputDir, { recursive: true, force: true }));
  const render = async (renderer: RendererId, presetId: RenderPresetId = "youtube-16x9", body?: string) => {
    const trackMetadata = (await inspectTrack(f.slug)).metadata!;
    const props = buildTrackProps({ slug: f.slug, metadata: trackMetadata, analysisAvailable: true });
    await publishExport(
      f.slug,
      presetId,
      fingerprintInputs(props, presetId, undefined, renderer, renderer === "after-effects" ? template : undefined),
      async (file) => {
        await writeFile(file, body ?? `${renderer}:${f.slug}:${presetId}`);
      },
      undefined,
      undefined,
      renderer,
    );
    return trackOutputLocation(f.slug, presetId, renderer);
  };
  return { ...f, template, render };
};

export const service = () => {
  const { registry, knobs } = mockRegistry();
  return { publishing: createPublishingService(registry), registry, knobs };
};

export const snapshotFile = async (file: string) => ({ bytes: await readFile(file), text: await readFile(file, "utf8") });
