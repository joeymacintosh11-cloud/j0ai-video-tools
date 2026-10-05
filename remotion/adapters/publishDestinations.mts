import type { DestinationCapabilities } from "../core/domain/publishing/destinations.ts";
import {
  createPublishDestinationRegistry,
  type DestinationConfiguration,
  type PublishDestinationRegistration,
} from "../core/ports/publishDestinationRegistry.ts";
import type { PublishDestinationDescriptor } from "../core/ports/publishDestination.ts";
import {
  destinationSettingsFor,
  readPublishingSettings,
} from "../services/publishing/destinationSettings.ts";
import { destinationWorkspace } from "../services/publishing/publishingStore.ts";
import {
  LOCAL_MOCK_BEHAVIORS,
  MOCK_CAPABILITIES_BASE,
  type LocalMockBehavior,
} from "./publishing/local-mock/localMockDestination.mts";

/**
 * Every publishing destination this installation has, by id.
 *
 * The one place that knows which adapter implements which destination — the
 * publishing twin of adapters/renderEngines.mts. Hosts (the API server and
 * the CLI) hand this registry to services/publishing; nothing else imports an
 * adapter. Adapters load lazily, so listing destinations loads none of them.
 *
 * Only local destinations exist in this milestone:
 *
 * - local-mock            every format (16:9 as video, 9:16 as short, 1:1 as post)
 * - local-mock-landscape  16:9 only, to exercise a single-format destination
 *
 * youtube, instagram and tiktok are reserved ids with no adapter, reported as
 * "not implemented" (core/domain/publishing/destinations.ts). A future adapter
 * registers itself here, e.g.
 *   { descriptor: YOUTUBE, probe, configured, load: async () => (await import("./publishing/youtube/youtubeDestination.mts")).youtubeDestination(...) }
 *
 * Non-secret settings come from publishing.local.json
 * (services/publishing/destinationSettings.ts). Credentials are never read
 * here; see core/ports/destinationCredentials.ts.
 */

const mockCapabilities = (formats: DestinationCapabilities["formats"]): DestinationCapabilities => ({
  ...MOCK_CAPABILITIES_BASE,
  formats,
});

export const LOCAL_MOCK: PublishDestinationDescriptor = {
  id: "local-mock",
  displayName: "Local mock (no network)",
  capabilities: mockCapabilities([
    { presetId: "youtube-16x9", mode: "video" },
    { presetId: "vertical-9x16", mode: "short" },
    { presetId: "square-1x1", mode: "post" },
  ]),
};

export const LOCAL_MOCK_LANDSCAPE: PublishDestinationDescriptor = {
  id: "local-mock-landscape",
  displayName: "Local mock, landscape only (no network)",
  capabilities: mockCapabilities([{ presetId: "youtube-16x9", mode: "video" }]),
};

const DEFAULT_ACCOUNT = "local";

const configured = (id: string) => (): DestinationConfiguration => {
  const { settings, problem } = readPublishingSettings();
  if (problem !== null) return { problem, accountId: null };
  const entry = destinationSettingsFor(settings, id);
  if (!entry.enabled) return { problem: `Disabled in publishing.local.json (destinations.${id}.enabled).`, accountId: null };
  const behavior = entry.options.simulate;
  if (behavior !== undefined && !LOCAL_MOCK_BEHAVIORS.includes(behavior as LocalMockBehavior))
    return { problem: `destinations.${id}.simulate must be one of ${LOCAL_MOCK_BEHAVIORS.join(", ")}.`, accountId: null };
  return { problem: null, accountId: entry.accountId ?? DEFAULT_ACCOUNT };
};

const mockRegistration = (descriptor: PublishDestinationDescriptor): PublishDestinationRegistration => ({
  descriptor,
  configured: configured(descriptor.id),
  load: async () => {
    const { createLocalMockDestination } = await import("./publishing/local-mock/localMockDestination.mts");
    const option = (key: string) => destinationSettingsFor(readPublishingSettings().settings, descriptor.id).options[key];
    return createLocalMockDestination({
      descriptor,
      workspace: () => destinationWorkspace(descriptor.id),
      behavior: () => (option("simulate") as LocalMockBehavior | undefined) ?? "success",
      delayMs: () => (typeof option("delayMs") === "number" ? Math.min(Math.max(option("delayMs") as number, 0), 60_000) : 0),
    });
  },
});

export const publishDestinations = createPublishDestinationRegistry([
  mockRegistration(LOCAL_MOCK),
  mockRegistration(LOCAL_MOCK_LANDSCAPE),
]);
