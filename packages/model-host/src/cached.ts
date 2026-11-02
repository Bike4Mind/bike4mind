export interface CachedOptions {
  /** A load still running after this long fails for its callers, and the next call starts afresh (ms). */
  timeoutMs?: number;
  timeoutError?: () => Error;
  now?: () => number;
}

function withDeadline<T>(promise: Promise<T>, timeoutMs: number, timeoutError: () => Error): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    timer.unref();
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/** Reuses a result for `maxAgeMs` and shares one call among concurrent callers; a failure is not kept. */
export function cached<T>(load: () => Promise<T>, maxAgeMs: number, options: CachedOptions = {}): () => Promise<T> {
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs;
  const timeoutError = options.timeoutError ?? (() => new Error(`Timed out after ${timeoutMs} ms`));
  let value: { at: number; result: T } | null = null;
  let pending: Promise<T> | null = null;
  return () => {
    if (value && now() - value.at < maxAgeMs) return Promise.resolve(value.result);
    if (pending) return pending;
    const loading = load();
    const attempt: Promise<T> = (timeoutMs ? withDeadline(loading, timeoutMs, timeoutError) : loading)
      .then(result => {
        value = { at: now(), result };
        return result;
      })
      .finally(() => {
        if (pending === attempt) pending = null;
      });
    pending = attempt;
    return attempt;
  };
}
