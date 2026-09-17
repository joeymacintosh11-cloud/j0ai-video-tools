import { useCallback, useRef } from "react";

/**
 * Guards state updates that resolve after the user has moved on.
 *
 * A request started for one track can finish after a different track has been
 * selected — the panels are one component instance re-rendered with new props,
 * so a late response would otherwise write one track's result into another's
 * view. The returned predicate reports whether the key a request was started
 * for is still the current one, so a stale result can be dropped instead.
 */
export const useStillCurrent = (
  key: string,
): ((startedWith: string) => boolean) => {
  const latest = useRef(key);
  latest.current = key;

  return useCallback((startedWith: string) => latest.current === startedWith, []);
};
