import { useCallback, useLayoutEffect, useRef } from 'react';

/**
 * Returns a stable callback reference that never changes identity,
 * but always calls the latest version of the provided function.
 * Useful for passing callbacks to memo'd children without breaking memoization.
 *
 * Usually you would use this when your function uses react-query hooks
 * This prevents rerenders to components that have function props with react-query calls.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useStableCallback<T extends (...args: any[]) => any>(fn: T): T {
  const ref = useRef(fn);
  useLayoutEffect(() => {
    ref.current = fn;
  });

  // eslint-disable-next-line react-hooks/use-memo
  return useCallback(((...args: Parameters<T>) => ref.current(...args)) as T, []);
}
