/**
 * Run `fn` with `listener` attached to `signal`'s `'abort'` event, guaranteeing
 * the listener is removed afterward - even if `fn` throws.
 *
 * Attaching an abort listener and only removing it on the success path leaks one
 * listener per failed call on a long-lived / reused `AbortSignal` (e.g. a single
 * per-quest signal shared across recursive tool turns and retries). Those
 * accumulate until Node emits `MaxListenersExceededWarning` and, left unchecked,
 * grow memory over the life of the process.
 *
 * When no signal is provided, `fn` runs without any listener bookkeeping.
 */
export async function withAbortListener<T>(
  signal: AbortSignal | undefined,
  listener: () => void,
  fn: () => Promise<T>
): Promise<T> {
  if (!signal) return fn();

  signal.addEventListener('abort', listener);
  try {
    return await fn();
  } finally {
    signal.removeEventListener('abort', listener);
  }
}
