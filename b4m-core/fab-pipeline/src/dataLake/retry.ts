// The retry helper the data-lake clients use: a deliberate copy of the retry loop in
// @bike4mind/common's retry.ts. MUST STAY IN SYNC with it on backoff semantics; that file carries the
// reciprocal note.
//
// Why a copy at all, precisely - because the reason is narrower than it used to be stated:
//
//  - It is the API that cannot be shared, not the package. This `withRetry` returns `Promise<T>` (the
//    raw result) where the upstream one returns `Promise<RetryResult<T>>`, and this one takes a
//    caller-injected `getRetryAfterMs` where the upstream one calls its own. So do NOT blindly swap
//    imports during a future consolidation - the signatures genuinely differ.
//  - There is NO dependency barrier to importing from @bike4mind/common: fab-pipeline already
//    declares it and already imports values from this directory (see BaseSearchIndex.ts). Its own
//    deps are hearth/axios/dayjs/zod, so nothing cycles back. Anything shareable SHOULD be imported
//    rather than copied, and `retryAfterHintOrNull` now is.
//  - The cycle that does exist is with @bike4mind/utils, which depends on @bike4mind/fab-pipeline, so
//    importing *utils* here would cycle. But utils holds no retry implementation to import - it
//    re-exports common's. Do not restate that cycle as a reason not to share anything with common: it
//    is not one, and stated too broadly it reads as forbidding the sharing this file now does.
//
// Feature parity (Retry-After handling, abortSignal cancellation) is maintained - see options below.

import { retryAfterHintOrNull } from '@bike4mind/common';

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
   * in milliseconds. When it returns a POSITIVE value, that delay (capped at `maxDelayMs`) is used
   * for the next wait instead of the calculated backoff - so we honor what the cluster asked for.
   *
   * A zero or negative return is treated as no hint at all, and the calculated backoff is used
   * instead. A delay that does not ask us to wait carries no timing information, and honoring it
   * would mean discarding the backoff for every remaining attempt at exactly the moment the server
   * is signalling distress. Guarded here rather than trusted from the extractor, since this option
   * is caller-injected.
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

      // Honor a server-requested Retry-After (capped) over the calculated backoff - but only a
      // POSITIVE one. `getRetryAfterMs` is caller-injected, so this cannot rely on the producer
      // having the rule: a zero or negative hint would otherwise win over the backoff (it is not
      // null) and collapse every remaining attempt into an immediate burst. Through the shared
      // predicate rather than an inline `> 0`, so the injected producer and this guard cannot end up
      // disagreeing about what counts as a usable hint.
      const rawRetryAfterMs = getRetryAfterMs?.(err);
      const retryAfterMs = rawRetryAfterMs == null ? null : retryAfterHintOrNull(rawRetryAfterMs);
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
