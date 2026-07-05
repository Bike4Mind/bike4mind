import { describe, it, expect, vi } from 'vitest';
import { withRetry, isRetryableError, calculateRetryDelay, getRetryAfterMs, isUserInitiatedAbort } from './retry';
import { AxiosError } from 'axios';

function createAxiosError(status: number, code?: string, headers?: Record<string, string>): AxiosError {
  const error = new Error(`Request failed with status ${status}`) as AxiosError;
  error.isAxiosError = true;
  error.response = {
    status,
    statusText: status === 429 ? 'Too Many Requests' : 'Error',
    headers: headers || {},
    data: {},
    config: {} as any,
  };
  if (code) {
    error.code = code;
  }
  return error;
}

describe('retry', () => {
  describe('isRetryableError', () => {
    it('should return true for 429 rate limit errors', () => {
      const error = createAxiosError(429);
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for 502 bad gateway errors', () => {
      const error = createAxiosError(502);
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for 503 service unavailable errors', () => {
      const error = createAxiosError(503);
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for 504 gateway timeout errors', () => {
      const error = createAxiosError(504);
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for ECONNRESET errors', () => {
      const error = createAxiosError(0, 'ECONNRESET');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for ETIMEDOUT errors', () => {
      const error = createAxiosError(0, 'ETIMEDOUT');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for non-Axios ECONNRESET errors', () => {
      const error = new Error('Connection reset') as Error & { code: string };
      error.code = 'ECONNRESET';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for TypeError: terminated (fetch abort)', () => {
      const error = new TypeError('terminated');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for rate limit message errors', () => {
      const error = new Error('rate limit exceeded');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for timeout message errors', () => {
      const error = new Error('Request timeout');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return false for 400 bad request errors', () => {
      const error = createAxiosError(400);
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for 401 unauthorized errors', () => {
      const error = createAxiosError(401);
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for 404 not found errors', () => {
      const error = createAxiosError(404);
      expect(isRetryableError(error)).toBe(false);
    });

    it('should return false for generic errors', () => {
      const error = new Error('Something went wrong');
      expect(isRetryableError(error)).toBe(false);
    });

    // TLS/network abort errors
    it('should return true for Error: aborted (TLS socket close #6936)', () => {
      const error = new Error('aborted');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for UND_ERR_SOCKET code (undici socket error)', () => {
      const error = new Error('Socket error') as Error & { code: string };
      error.code = 'UND_ERR_SOCKET';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for UND_ERR_CONNECT_TIMEOUT code', () => {
      const error = new Error('Connection timeout') as Error & { code: string };
      error.code = 'UND_ERR_CONNECT_TIMEOUT';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for ENOTFOUND code (DNS failure)', () => {
      const error = new Error('DNS lookup failed') as Error & { code: string };
      error.code = 'ENOTFOUND';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for EAI_AGAIN code (temporary DNS failure)', () => {
      const error = new Error('DNS temporarily unavailable') as Error & { code: string };
      error.code = 'EAI_AGAIN';
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for fetch failed message', () => {
      const error = new Error('fetch failed');
      expect(isRetryableError(error)).toBe(true);
    });

    it('should return true for socket closed message', () => {
      const error = new Error('socket closed unexpectedly');
      expect(isRetryableError(error)).toBe(true);
    });
  });

  describe('isUserInitiatedAbort', () => {
    it('should return true when userSignal is already aborted', () => {
      const error = new Error('aborted');
      const controller = new AbortController();
      controller.abort();
      expect(isUserInitiatedAbort(error, controller.signal)).toBe(true);
    });

    it('should return false for AbortError when userSignal exists but is not aborted', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      const controller = new AbortController();
      // Signal is NOT aborted - this is a network abort, not user-initiated
      expect(isUserInitiatedAbort(error, controller.signal)).toBe(false);
    });

    it('should return false for "Error: aborted" when userSignal exists but is not aborted', () => {
      // TLS socket close error
      const error = new Error('aborted');
      const controller = new AbortController();
      // Signal is NOT aborted - this is a network abort (retryable)
      expect(isUserInitiatedAbort(error, controller.signal)).toBe(false);
    });

    it('should return true for AbortError with no signal context', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      // No signal context - assume user-initiated (conservative)
      expect(isUserInitiatedAbort(error, undefined)).toBe(true);
    });

    it('should return false for non-abort errors', () => {
      const error = new Error('Network error');
      const controller = new AbortController();
      expect(isUserInitiatedAbort(error, controller.signal)).toBe(false);
    });

    it('should return false for non-abort errors even without signal', () => {
      const error = new Error('ECONNRESET');
      expect(isUserInitiatedAbort(error, undefined)).toBe(false);
    });
  });

  describe('getRetryAfterMs', () => {
    it('should return null for non-Axios errors', () => {
      const error = new Error('test');
      expect(getRetryAfterMs(error)).toBeNull();
    });

    it('should return null when no Retry-After header', () => {
      const error = createAxiosError(429);
      expect(getRetryAfterMs(error)).toBeNull();
    });

    it('should parse Retry-After as seconds', () => {
      const error = createAxiosError(429, undefined, { 'retry-after': '5' });
      expect(getRetryAfterMs(error)).toBe(5000);
    });

    it('should parse Retry-After as HTTP date', () => {
      const futureDate = new Date(Date.now() + 3000);
      const error = createAxiosError(429, undefined, {
        'retry-after': futureDate.toUTCString(),
      });
      const result = getRetryAfterMs(error);
      expect(result).toBeGreaterThan(2000);
      expect(result).toBeLessThan(4000);
    });
  });

  describe('calculateRetryDelay', () => {
    it('should return initial delay for first attempt', () => {
      // With 0 jitter
      const delay = calculateRetryDelay(0, 100, 5000, 0);
      expect(delay).toBe(100);
    });

    it('should double delay for each attempt (exponential backoff)', () => {
      const delay0 = calculateRetryDelay(0, 100, 10000, 0);
      const delay1 = calculateRetryDelay(1, 100, 10000, 0);
      const delay2 = calculateRetryDelay(2, 100, 10000, 0);
      const delay3 = calculateRetryDelay(3, 100, 10000, 0);

      expect(delay0).toBe(100);
      expect(delay1).toBe(200);
      expect(delay2).toBe(400);
      expect(delay3).toBe(800);
    });

    it('should cap delay at maxDelayMs', () => {
      const delay = calculateRetryDelay(10, 100, 5000, 0);
      expect(delay).toBe(5000);
    });

    it('should add jitter when jitterFactor > 0', () => {
      // Run multiple times to check jitter varies
      const delays = Array.from({ length: 10 }, () => calculateRetryDelay(0, 1000, 5000, 0.1));

      // Not all delays should be exactly the same
      const uniqueDelays = new Set(delays);
      expect(uniqueDelays.size).toBeGreaterThan(1);

      // All delays should be within jitter range (1000 ± 10%)
      delays.forEach(delay => {
        expect(delay).toBeGreaterThanOrEqual(900);
        expect(delay).toBeLessThanOrEqual(1100);
      });
    });
  });

  describe('withRetry', () => {
    // Use short delays for real-time tests
    const shortDelay = { initialDelayMs: 5, maxDelayMs: 20, jitterFactor: 0 };

    it('should return result on first success', async () => {
      const fn = vi.fn().mockResolvedValue('success');

      const { result, attempts } = await withRetry(fn);

      expect(result).toBe('success');
      expect(attempts).toBe(0);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should retry on retryable error and succeed', async () => {
      const fn = vi.fn().mockRejectedValueOnce(createAxiosError(429)).mockResolvedValue('success');

      const { result, attempts } = await withRetry(fn, shortDelay);

      expect(result).toBe('success');
      expect(attempts).toBe(1);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it('should throw after maxRetries exceeded', async () => {
      const error = createAxiosError(429);
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, { maxRetries: 2, ...shortDelay })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(3); // Initial + 2 retries
    });

    it('should not retry non-retryable errors', async () => {
      const error = createAxiosError(400);
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, { maxRetries: 3 })).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should call logger on retry', async () => {
      const logger = {
        info: vi.fn(),
        warn: vi.fn(),
      };

      const fn = vi.fn().mockRejectedValueOnce(createAxiosError(429)).mockResolvedValue('success');

      await withRetry(fn, { logger, ...shortDelay });

      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Retry attempt'),
        expect.objectContaining({ attempt: 1 })
      );
    });

    it('should respect abort signal', async () => {
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(createAxiosError(429));

      const promise = withRetry(fn, {
        maxRetries: 5,
        initialDelayMs: 50,
        abortSignal: controller.signal,
      });

      setTimeout(() => controller.abort(), 10);

      await expect(promise).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(1);
    });

    it('should track total delay time', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createAxiosError(429))
        .mockRejectedValueOnce(createAxiosError(429))
        .mockResolvedValue('success');

      const { totalDelayMs, attempts } = await withRetry(fn, shortDelay);

      expect(attempts).toBe(2);
      // With jitterFactor 0: delay1 = 5, delay2 = 10 = 15ms total
      expect(totalDelayMs).toBe(15);
    });

    it('should use custom isRetryable function', async () => {
      const customRetryable = vi.fn().mockReturnValue(false);
      const error = createAxiosError(429);
      const fn = vi.fn().mockRejectedValue(error);

      await expect(withRetry(fn, { maxRetries: 3, isRetryable: customRetryable })).rejects.toThrow();

      expect(fn).toHaveBeenCalledTimes(1);
      expect(customRetryable).toHaveBeenCalledWith(error);
    });

    it('should use exponential backoff', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createAxiosError(429))
        .mockRejectedValueOnce(createAxiosError(429))
        .mockRejectedValueOnce(createAxiosError(429))
        .mockResolvedValue('success');

      const { totalDelayMs } = await withRetry(fn, {
        maxRetries: 5,
        initialDelayMs: 10,
        maxDelayMs: 100,
        jitterFactor: 0,
      });

      // Delays: 10, 20, 40 = 70ms total (exponential backoff)
      expect(totalDelayMs).toBe(70);
    });

    it('should cap delay at maxDelayMs', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createAxiosError(429))
        .mockRejectedValueOnce(createAxiosError(429))
        .mockRejectedValueOnce(createAxiosError(429))
        .mockResolvedValue('success');

      const { totalDelayMs } = await withRetry(fn, {
        maxRetries: 5,
        initialDelayMs: 10,
        maxDelayMs: 15, // Cap at 15ms
        jitterFactor: 0,
      });

      // Delays: 10, 15 (capped from 20), 15 (capped from 40) = 40ms
      expect(totalDelayMs).toBe(40);
    });
  });
});
