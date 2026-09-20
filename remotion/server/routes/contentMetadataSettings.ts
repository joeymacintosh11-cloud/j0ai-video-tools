import type { IncomingMessage, ServerResponse } from "node:http";
import type { ContentMetadataSettingsView } from "../../src/domain/api/views.ts";
import {
  CONTENT_METADATA_SETTINGS_FILE,
  readContentMetadataSettings,
  writeContentMetadataSettingsPatch,
} from "../../services/content/metadataTemplateSettings.ts";
import { readJsonBody, sendOk } from "../http/json.ts";

/**
 * Global content-metadata template settings: the machine-local overrides
 * that sit between a track's own overrides and the built-in defaults.
 *
 * Mirrors GET/PUT /api/delivery/settings exactly — same shape of endpoint,
 * same "absent means off/unconfigured, malformed is surfaced not hidden"
 * behavior.
 */

const toView = async (): Promise<ContentMetadataSettingsView> => {
  const { settings, problem } = await readContentMetadataSettings();

  return {
    schemaVersion: settings.schemaVersion,
    templates: settings.templates,
    problem,
    settingsPath: CONTENT_METADATA_SETTINGS_FILE,
  };
};

export const handleGetContentMetadataSettings = async (
  response: ServerResponse,
): Promise<void> => {
  sendOk(response, await toView());
};

export const handleUpdateContentMetadataSettings = async (
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> => {
  const body = await readJsonBody(request);

  await writeContentMetadataSettingsPatch(body);

  sendOk(response, await toView());
};
