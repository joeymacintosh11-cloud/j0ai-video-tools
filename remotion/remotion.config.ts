/**
 * Note: When using the Node.JS APIs, the config file
 * doesn't apply. Instead, pass options directly to the APIs.
 *
 * All configuration options: https://remotion.dev/docs/config
 */

import { Config } from "@remotion/cli/config";

// The composition lives in the Remotion adapter, not in Remotion's default
// src/ — see ARCHITECTURE.md. Studio and `remotion bundle` start here.
Config.setEntryPoint("./adapters/remotion/index.ts");
Config.setRspack(true);
Config.setVideoImageFormat("jpeg");
Config.setOverwriteOutput(true);
