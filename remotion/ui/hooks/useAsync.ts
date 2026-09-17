import { useCallback, useEffect, useState } from "react";
import { ApiRequestError } from "../api/client.ts";

/**
 * Loads data from the API and re-runs when its dependencies change.
 *
 * The filesystem is the source of truth, so this app deliberately has no
 * client-side cache and no optimistic state: after any mutation the caller
 * calls reload() and re-reads what the server actually has.
 */

export type AsyncState<TData> = {
  readonly data: TData | null;
  readonly error: ApiRequestError | null;
  /** True only on the first load; a reload keeps the previous data visible. */
  readonly loading: boolean;
  readonly reload: () => void;
};

const toApiError = (error: unknown): ApiRequestError =>
  error instanceof ApiRequestError
    ? error
    : new ApiRequestError(0, {
        code: "INTERNAL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      });

export const useAsync = <TData,>(
  load: () => Promise<TData>,
  deps: readonly unknown[],
): AsyncState<TData> => {
  const [data, setData] = useState<TData | null>(null);
  const [error, setError] = useState<ApiRequestError | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    load()
      .then((result) => {
        if (!cancelled) {
          setData(result);
          setError(null);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(toApiError(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
    // `load` is redefined every render by callers, so the caller's own deps
    // decide when to re-fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  const reload = useCallback(() => {
    setNonce((previous) => previous + 1);
  }, []);

  return { data, error, loading, reload };
};
