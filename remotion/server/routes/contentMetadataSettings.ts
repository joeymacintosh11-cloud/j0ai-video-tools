import type { IncomingMessage, ServerResponse } from "node:http";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
import { parseMetadataTemplatesResetPatch } from "../../core/domain/content/metadataTemplates.ts";
import type { ContentMetadataSettingsView } from "../../core/domain/api/views.ts";
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
  const { settings, problem, revision } = await readContentMetadataSettings();

  return {
    schemaVersion: settings.schemaVersion,
    revision,
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
  if (Object.keys(body).length === 0) {
    throw new TrackError(trackIssue("INVALID_REQUEST", "Provide at least one template field to set or reset."));
  }
  const parsed = parseMetadataTemplatesResetPatch(body);
  if (parsed.problems.length === 0 && parsed.patch === null) {
    throw new TrackError(trackIssue("INVALID_REQUEST", "Provide at least one template field to set or reset."));
  }
  const ifMatch = request.headers["if-match"];
  if (ifMatch !== undefined &&
      (typeof ifMatch !== "string" || !/^"(?:[a-f0-9]{64}|missing|unreadable)"$/.test(ifMatch))) {
    throw new TrackError(trackIssue("INVALID_REQUEST", "If-Match must contain a quoted settings revision."));
  }
  const { settings, revision } = await writeContentMetadataSettingsPatch(body, ifMatch?.slice(1, -1));
  sendOk(response, { schemaVersion: settings.schemaVersion, templates: settings.templates,
    revision, problem: null, settingsPath: CONTENT_METADATA_SETTINGS_FILE } satisfies ContentMetadataSettingsView);
};
