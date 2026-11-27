import { withRetry, type RetryOptions } from '@bike4mind/common';
import { isMongoNetworkError } from '@bike4mind/db-core';

export const MARK_FAILED_RETRY: Pick<RetryOptions, 'maxRetries' | 'initialDelayMs' | 'maxDelayMs'> = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 2000,
};

// Covers the worst-case backoff (~3.5s) plus the failed websocket event and quest persist that follow.
export const MARK_FAILED_MIN_REMAINING_MS = 10_000;

/**
 * Retries a failed `markFailed` write through a brief DB outage. Redelivering the SQS message
 * cannot repair it: the CAS claim expects `continuing`/`pending`, so it loses on a `running`
 * execution. Only socket-level Mongo errors are retried; server-selection timeouts have already
 * waited their full timeout. Rethrows once spent so the caller can fall back to the sweep.
 */
export async function markFailedWithRetry(
  markFailed: () => Promise<unknown>,
  logger: NonNullable<RetryOptions['logger']>,
  options: { getRemainingMs?: () => number; retry?: Partial<RetryOptions> } = {}
): Promise<void> {
  const { getRemainingMs, retry } = options;
  await withRetry(markFailed, {
    ...MARK_FAILED_RETRY,
    isRetryable: error =>
      isMongoNetworkError(error) && (getRemainingMs === undefined || getRemainingMs() > MARK_FAILED_MIN_REMAINING_MS),
    logger,
    ...retry,
  });
}
