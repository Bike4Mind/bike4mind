import { withRetry, type RetryOptions } from '@bike4mind/common';
import { isMongoNetworkError } from '@bike4mind/db-core';

const MARK_FAILED_RETRY: Pick<RetryOptions, 'maxRetries' | 'initialDelayMs' | 'maxDelayMs'> = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 2000,
};

// Checked only between attempts: covers the retry backoff (~3.85s with jitter) plus the cleanup that
// follows. A single attempt can still block up to the driver's socketTimeoutMS, which this does not bound.
export const MARK_FAILED_MIN_REMAINING_MS = 10_000;

/**
 * Retries a failed `markFailed` write through a brief DB outage. Redelivering the SQS message
 * cannot repair it: the CAS claim expects `continuing`/`pending`, so it loses on a `running`
 * execution. Only socket-level Mongo errors are retried; server-selection timeouts have already
 * waited their full timeout. Resolves to the write's result; rethrows once spent so the caller
 * can fall back to the sweep.
 */
export async function markFailedWithRetry<T>(
  markFailed: () => Promise<T>,
  logger: NonNullable<RetryOptions['logger']>,
  options: { getRemainingMs?: () => number; retry?: Partial<RetryOptions> } = {}
): Promise<T> {
  const { getRemainingMs, retry } = options;
  const { result } = await withRetry(markFailed, {
    ...MARK_FAILED_RETRY,
    isRetryable: error =>
      isMongoNetworkError(error) && (getRemainingMs === undefined || getRemainingMs() > MARK_FAILED_MIN_REMAINING_MS),
    logger,
    ...retry,
  });
  return result;
}
