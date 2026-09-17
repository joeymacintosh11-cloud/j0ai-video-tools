import { useEffect } from "react";

/**
 * Runs a callback when the window regains focus.
 *
 * metadata.json can be edited in a text editor while the app is open, and the
 * API has no optimistic-concurrency guard, so re-reading on focus is how the UI
 * notices external edits instead of showing stale data.
 */
export const useWindowFocus = (onFocus: () => void): void => {
  useEffect(() => {
    window.addEventListener("focus", onFocus);

    return () => {
      window.removeEventListener("focus", onFocus);
    };
  }, [onFocus]);
};
