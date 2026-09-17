import type { ApiRequestError } from "../api/client.ts";

/**
 * Shows a structured API failure: the friendly message first, with the domain
 * error code and path available but secondary. Stack traces (`details`) are
 * never the only thing shown, matching the server's own error contract.
 */
export const ErrorBanner: React.FC<{
  readonly error: ApiRequestError;
  readonly title?: string;
}> = ({ error, title = "Something went wrong" }) => (
  <div className="banner" role="alert">
    <div className="banner__title">{title}</div>
    <div className="banner__message">{error.message}</div>
    <div className="banner__code">
      {error.code}
      {error.status > 0 ? ` · HTTP ${error.status}` : ""}
      {error.path ? ` · ${error.path}` : ""}
    </div>
  </div>
);
