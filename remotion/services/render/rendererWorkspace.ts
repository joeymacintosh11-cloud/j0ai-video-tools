import type { RendererWorkspace } from "../../core/ports/rendererWorkspace.ts";
import { TrackError, trackIssue } from "../../core/domain/tracks/errors.ts";
let workspace: RendererWorkspace | null = null;
export const registerRendererWorkspace = (port: RendererWorkspace): void => {
  workspace = port;
};
export const rendererWorkspace = (): RendererWorkspace => {
  if (workspace === null)
    throw new TrackError(
      trackIssue(
        "RENDERER_NOT_CONFIGURED",
        "Renderer workspace inspection is not registered.",
      ),
    );
  return workspace;
};
