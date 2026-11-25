// Dependency-free: p-limit v4+ is ESM-only and arrives non-callable through the CJS bundles'
// require() interop in self-host containers; vitest's own interop hides that, so no test catches it.

/**
 * Returns a `limit(task)` function that runs at most `limit` tasks at once and
 * starts queued tasks in submission order. Each call resolves or rejects with
 * its own task's outcome; a failed task frees its slot like a finished one. Throws a TypeError
 * unless `limit` is a positive integer or Infinity, as p-limit does.
 */
export function limitConcurrency(limit: number): <T>(task: () => Promise<T> | T) => Promise<T> {
  if (!((Number.isInteger(limit) || limit === Infinity) && limit > 0)) {
    throw new TypeError('Expected `limit` to be a number from 1 and up');
  }
  const cap = limit;
  let active = 0;
  const waiting: Array<() => void> = [];

  return async task => {
    // A finishing task hands its slot straight to the next waiter instead of freeing it, so a task
    // submitted in the microtask before the waiter resumes cannot take the slot and jump the queue.
    if (active >= cap) await new Promise<void>(resolve => waiting.push(resolve));
    else active += 1;
    try {
      return await task();
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}

/**
 * Serializes async tasks in submission order. A task that throws rejects only its own
 * `runExclusive` call; the next task still runs. An empty task works as a barrier that
 * resolves once everything submitted before it has settled.
 */
export function createMutex(): { runExclusive<T>(task: () => Promise<T> | T): Promise<T> } {
  let tail: Promise<void> = Promise.resolve();

  return {
    runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
      const run = tail.then(() => task());
      tail = run.then(
        () => undefined,
        () => undefined
      );
      return run;
    },
  };
}
