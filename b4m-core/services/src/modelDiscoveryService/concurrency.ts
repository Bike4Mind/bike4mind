/**
 * Minimal p-limit replacement for the discovery runner and sources.
 *
 * p-limit v4+ is ESM-only, and the services CJS bundle loads it through a
 * require() interop that wraps the module namespace a second time, so at
 * runtime in the self-host containers `pLimit` arrives as a non-callable
 * namespace ("p_limit.default is not a function"). Vitest's own interop hides
 * the mismatch, which is why no test can catch it. Discovery therefore keeps
 * its concurrency cap dependency-free.
 */
export function limitConcurrency(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  const cap = Math.max(1, Math.floor(limit));
  let active = 0;
  const waiting: Array<() => void> = [];

  return async task => {
    // A loop, not an if: a released waiter resumes one microtask after the slot
    // was freed, and a task submitted in that window takes the slot first. The
    // waiter has to re-verify rather than trust the release.
    while (active >= cap) await new Promise<void>(resolve => waiting.push(resolve));
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}
