import { withRetry, type RetryOptions } from '@bike4mind/common';

/**
 * Persists a terminal `failed` state, retrying through a brief DB outage.
 *
 * Redelivering the SQS message cannot repair a failed `markFailed`: the redelivery goes through
 * the CAS claim, which expects `continuing`/`pending`, but the execution is still `running`, so
 * the claim loses and the message is acked with nothing fixed. Retrying in-process is the only
 * path that closes the gap before the hourly abandoned-execution sweep. Still throws once the
 * retries are spent, so the caller can fall back to that sweep.
 *
 * Own module with structural deps so it unit-tests without the executor's Mongo/AWS imports.
 */

export const MARK_FAILED_RETRY: Pick<RetryOptions, 'maxRetries' | 'initialDelayMs' | 'maxDelayMs'> = {
  maxRetries: 3,
  initialDelayMs: 500,
  maxDelayMs: 2000,
};

export async function markFailedWithRetry<TError>(
  markFailed: (executionId: string, error: TError) => Promise<unknown>,
  executionId: string,
  error: TError,
  logger: NonNullable<RetryOptions['logger']>,
  retryOptions: Partial<RetryOptions> = {}
): Promise<void> {
  await withRetry(() => markFailed(executionId, error), {
    ...MARK_FAILED_RETRY,
    // Mongo outages surface under many error shapes; the default heuristic is network-oriented.
    isRetryable: () => true,
    logger,
    ...retryOptions,
  });
}
