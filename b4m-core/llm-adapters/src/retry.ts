// NOTE: a copy of this file exists in @bike4mind/utils/src/retry.ts - keep in sync
import { isAxiosError } from 'axios';

/**
 * Options for the retry function
 */
export interface RetryOptions {
  /** Maximum number of retry attempts (default: 3) */
  maxRetries?: number;
  /** Initial delay in milliseconds before first retry (default: 100) */
  initialDelayMs?: number;
  /** Maximum delay in milliseconds between retries (default: 5000) */
  maxDelayMs?: number;
  /** Jitter factor (0-1) to randomize delays and prevent thundering herd (default: 0.1) */
  jitterFactor?: number;
  /** Custom function to determine if an error is retryable */
  isRetryable?: (error: Error) => boolean;
  /** Optional logger for retry attempts */
  logger?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
  /** Optional abort signal to cancel retries */
  abortSignal?: AbortSignal;
}

/**
 * Result of a retry operation
 */
export interface RetryResult<T> {
  /** The successful result */
  result: T;
  /** Number of retry attempts made (0 = succeeded on first try) */
  attempts: number;
  /** Total time spent in retry delays (ms) */
  totalDelayMs: number;
}

/**
 * Default retryable errors for LLM API calls
 */
export function isRetryableError(error: Error): boolean {
  const message = error.message.toLowerCase();

  // Check Axios errors
  if (isAxiosError(error)) {
    const status = error.response?.status;

    // Rate limiting - always retry with backoff
    if (status === 429) {
      return true;
    }

    // Server errors that may be transient
    if (status === 502 || status === 503 || status === 504) {
      return true;
    }

    // Network connection errors
    if (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT' || error.code === 'ECONNREFUSED') {
      return true;
    }
  }

  // Check for ECONNRESET in error code property (non-Axios errors)
  if ('code' in error && (error.code === 'ECONNRESET' || error.code === 'ETIMEDOUT')) {
    return true;
  }

  // Check for undici-specific error codes
  const undiciCodes = ['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'];
  if ('code' in error && undiciCodes.includes(String(error.code))) {
    return true;
  }

  // Check for DNS failures (transient)
  if ('code' in error && (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN')) {
    return true;
  }

  // Check for TypeError: terminated (from undici/fetch)
  if (error.name === 'TypeError' && message.includes('terminated')) {
    return true;
  }

  // Check for common transient error messages
  const retryablePatterns = [
    'econnreset',
    'etimedout',
    'connection reset',
    'connection refused',
    'socket hang up',
    'terminated',
    'network error',
    'timeout',
    'rate limit',
    'too many requests',
    'service unavailable',
    'bad gateway',
    'gateway timeout',
    'overloaded',
    // Additional patterns for TLS/socket errors
    'aborted', // TLS socket close
    'socket closed', // Generic socket termination
    'connection closed', // Connection termination
    'enotfound', // DNS lookup failure
    'eai_again', // Temporary DNS failure
    'und_err_socket', // Undici socket error
    'und_err_connect_timeout', // Undici connection timeout
    'fetch failed', // Generic fetch failure
  ];

  return retryablePatterns.some(pattern => message.includes(pattern));
}

/**
 * Check if an error represents a user-initiated abort (should NOT retry)
 * vs a network-level abort (should retry).
 *
 * This is important for LLM API calls where we want to retry transient network
 * failures (TLS socket close, undici fetch abort) but NOT retry
 * when the user intentionally cancels the request.
 *
 * @param error - The error that was thrown
 * @param userSignal - The user's abort signal (if any)
 * @returns true if this was a user-initiated abort (don't retry), false otherwise (retry)
 */
export function isUserInitiatedAbort(error: Error, userSignal?: AbortSignal): boolean {
  // If user's signal is already aborted, this was intentional
  if (userSignal?.aborted) {
    return true;
  }

  // Check if this is an abort-related error
  const isAbortError = error.name === 'AbortError' || (error.name === 'Error' && error.message === 'aborted');

  // If it's an AbortError but userSignal exists and is NOT aborted,
  // this is likely a network-level abort (TLS socket close), not user-initiated
  if (isAbortError && userSignal && !userSignal.aborted) {
    return false; // Network abort - retryable
  }

  // AbortError with no signal context - assume user-initiated (don't retry)
  // This is conservative: better to not retry than to retry user cancellations
  return isAbortError && !userSignal;
}

/**
 * Extract retry delay from error response (e.g., Retry-After header)
 */
export function getRetryAfterMs(error: Error): number | null {
  if (!isAxiosError(error)) {
    return null;
  }

  const retryAfter = error.response?.headers?.['retry-after'];
  if (!retryAfter) {
    return null;
  }

  // Retry-After can be a number of seconds or an HTTP date
  const seconds = parseInt(retryAfter, 10);
  if (!isNaN(seconds)) {
    return seconds * 1000;
  }

  // Try parsing as HTTP date
  const date = Date.parse(retryAfter);
  if (!isNaN(date)) {
    return Math.max(0, date - Date.now());
  }

  return null;
}

/**
 * Calculate delay for a retry attempt using exponential backoff with jitter
 */
export function calculateRetryDelay(
  attempt: number,
  initialDelayMs: number,
  maxDelayMs: number,
  jitterFactor: number
): number {
  // Exponential backoff: delay = initialDelay * 2^attempt
  const exponentialDelay = initialDelayMs * Math.pow(2, attempt);

  // Cap at maximum delay
  const cappedDelay = Math.min(exponentialDelay, maxDelayMs);

  // Add jitter: random value between -jitter and +jitter
  const jitter = cappedDelay * jitterFactor * (Math.random() * 2 - 1);

  return Math.max(0, Math.round(cappedDelay + jitter));
}

/**
 * Sleep for a specified duration, respecting abort signal
 */
async function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }

    const timeout = setTimeout(resolve, ms);

    abortSignal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout);
        reject(new Error('Aborted'));
      },
      { once: true }
    );
  });
}

/**
 * Execute a function with automatic retry on transient failures.
 *
 * Uses exponential backoff with jitter to space out retry attempts.
 * Respects Retry-After headers when present (e.g., for 429 rate limiting).
 *
 * @example
 * ```typescript
 * const result = await withRetry(
 *   () => anthropicClient.messages.create({ ... }),
 *   {
 *     maxRetries: 3,
 *     initialDelayMs: 100,
 *     logger: myLogger,
 *   }
 * );
 * ```
 */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<RetryResult<T>> {
  const {
    maxRetries = 3,
    initialDelayMs = 100,
    maxDelayMs = 5000,
    jitterFactor = 0.1,
    isRetryable = isRetryableError,
    logger,
    abortSignal,
  } = options;

  let attempts = 0;
  let totalDelayMs = 0;

  while (true) {
    try {
      // Check if aborted before attempting
      if (abortSignal?.aborted) {
        throw new Error('Aborted');
      }

      const result = await fn();
      return { result, attempts, totalDelayMs };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      // Check if we should retry
      if (attempts >= maxRetries || !isRetryable(err)) {
        throw error;
      }

      // Check if aborted
      if (abortSignal?.aborted) {
        throw error;
      }

      // Calculate delay
      let delayMs = calculateRetryDelay(attempts, initialDelayMs, maxDelayMs, jitterFactor);

      // Check for Retry-After header (overrides calculated delay)
      const retryAfterMs = getRetryAfterMs(err);
      if (retryAfterMs !== null) {
        delayMs = Math.min(retryAfterMs, maxDelayMs);
        logger?.info(`Rate limited, using Retry-After delay`, {
          retryAfterMs,
          actualDelayMs: delayMs,
        });
      }

      attempts++;
      totalDelayMs += delayMs;

      logger?.warn(`Retry attempt ${attempts}/${maxRetries} after ${delayMs}ms`, {
        error: err.message,
        errorCode: 'code' in err ? err.code : undefined,
        attempt: attempts,
        delayMs,
      });

      // Wait before retrying
      try {
        await sleep(delayMs, abortSignal);
      } catch {
        // Aborted during sleep
        throw error;
      }
    }
  }
}
