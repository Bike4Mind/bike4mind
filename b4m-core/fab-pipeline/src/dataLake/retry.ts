// Self-contained retry helper for the data-lake clients.
//
// NOTE: this is a deliberately small, dependency-free copy of the retry logic in
// @bike4mind/utils/src/retry.ts. We cannot import that package here: @bike4mind/utils
// already depends on @bike4mind/fab-pipeline, so depending on it back would create a
// circular package dependency. Keep the backoff *semantics* in sync with that file.
//
// This copy's API intentionally differs from the utils version - do NOT blindly swap imports
// during any future consolidation: this `withRetry` returns `Promise<T>` (the raw result),
// whereas the utils version returns `Promise<RetryResult<T>>` (`{ result, attempts, totalDelayMs }`).
// Feature parity (Retry-After handling, abortSignal cancellation) is maintained - see options below.

export interface RetryOptions {
  /** Maximum number of retry attempts after the initial try (default: 3). */
  maxRetries?: number;
  /** Initial delay in milliseconds before the first retry (default: 100). */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds between retries (default: 5000). */
  maxDelayMs?: number;
  /** Jitter factor (0-1) to randomize delays and prevent thundering herd (default: 0.1). */
  jitterFactor?: number;
  /** Determines whether a thrown error is worth retrying. */
  isRetryable: (error: Error) => boolean;
  /**
   * Optional: extract a server-requested delay (e.g. a `Retry-After` header) from the error,
   * in milliseconds. When it returns a value, that delay (capped at `maxDelayMs`) is used for
   * the next wait instead of the calculated backoff - so we honor what the cluster asked for.
   */
  getRetryAfterMs?: (error: Error) => number | null;
  /** Optional signal to cancel retries - checked before each attempt and during the backoff sleep. */
  abortSignal?: AbortSignal;
  /** Optional logger for retry attempts. */
  logger?: {
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}

/** Sleep for `ms`, rejecting early if `abortSignal` fires so a long backoff can be cancelled. */
function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    const timer = setTimeout(() => {
      abortSignal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    abortSignal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Exponential backoff with bidirectional jitter: initialDelay * 2^attempt, capped at maxDelay. */
function calculateRetryDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number
): number {
  const cappedDelay = Math.min(initialDelayMs * 2 ** attempt, maxDelayMs);
  // Jitter spans +/-jitterFactor so retries spread both earlier and later (matches @bike4mind/utils).
  const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Run `fn`, retrying with bounded exponential backoff while `isRetryable` returns true.
 * Re-throws the last error once retries are exhausted or the error is non-retryable.
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    jitterFactor = 0.1,
    isRetryable,
    getRetryAfterMs,
    abortSignal,
    logger,
  } = options;

  let attempts = 0;
  while (true) {
    if (abortSignal?.aborted) {
      throw new Error('Aborted');
    }
    try {
      return await fn();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      if (attempts >= maxRetries || !isRetryable(err) || abortSignal?.aborted) {
        throw error;
      }

      // Honor a server-requested Retry-After (capped) over the calculated backoff.
      const retryAfterMs = getRetryAfterMs?.(err) ?? null;
      const delayMs =
        retryAfterMs !== null
          ? Math.min(retryAfterMs, maxDelayMs)
          : calculateRetryDelay(attempts, initialDelayMs, maxDelayMs, jitterFactor);
      attempts++;
      logger?.warn(`Retry attempt ${attempts}/${maxRetries} after ${delayMs}ms`, {
        error: err.message,
        attempt: attempts,
        delayMs,
        retryAfter: retryAfterMs !== null,
      });
      try {
        await sleep(delayMs, abortSignal);
      } catch {
        // Aborted during the backoff - surface the original error, not the abort.
        throw error;
      }
    }
  }
}
