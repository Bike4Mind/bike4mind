import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry } from './retry';

const alwaysRetry = () => true;

describe('withRetry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('returns the result after retrying a retryable error', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce('ok');
    const promise = withRetry(fn, { isRetryable: alwaysRetry, initialDelayMs: 10 });
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('does not retry a non-retryable error', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('nope'));
    const promise = withRetry(fn, { isRetryable: () => false });
    const assertion = expect(promise).rejects.toThrow('nope');
    await vi.runAllTimersAsync();
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  describe('Retry-After handling', () => {
    it('uses getRetryAfterMs for the wait instead of calculated backoff', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const fn = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce('ok');
      const promise = withRetry(fn, {
        isRetryable: alwaysRetry,
        initialDelayMs: 100,
        maxDelayMs: 60_000,
        getRetryAfterMs: () => 2_000,
      });
      await vi.runAllTimersAsync();
      await expect(promise).resolves.toBe('ok');
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 2_000);
    });

    it('caps the Retry-After delay at maxDelayMs', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const fn = vi.fn().mockRejectedValueOnce(new Error('429')).mockResolvedValueOnce('ok');
      const promise = withRetry(fn, {
        isRetryable: alwaysRetry,
        maxDelayMs: 5_000,
        getRetryAfterMs: () => 99_999,
      });
      await vi.runAllTimersAsync();
      await promise;
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5_000);
    });

    it('falls back to calculated backoff when getRetryAfterMs returns null', async () => {
      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
      const fn = vi.fn().mockRejectedValueOnce(new Error('503')).mockResolvedValueOnce('ok');
      const promise = withRetry(fn, {
        isRetryable: alwaysRetry,
        initialDelayMs: 200,
        jitterFactor: 0,
        getRetryAfterMs: () => null,
      });
      await vi.runAllTimersAsync();
      await promise;
      // initialDelay * 2^0 with zero jitter = 200ms calculated backoff
      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 200);
    });
  });

  describe('abortSignal', () => {
    it('does not even attempt when the signal is already aborted', async () => {
      const controller = new AbortController();
      controller.abort();
      const fn = vi.fn().mockResolvedValue('ok');
      const promise = withRetry(fn, { isRetryable: alwaysRetry, abortSignal: controller.signal });
      const assertion = expect(promise).rejects.toThrow('Aborted');
      await vi.runAllTimersAsync();
      await assertion;
      expect(fn).toHaveBeenCalledTimes(0);
    });

    it('aborts during the backoff and surfaces the original error', async () => {
      vi.useRealTimers();
      const controller = new AbortController();
      const fn = vi.fn().mockRejectedValue(new Error('original'));
      const promise = withRetry(fn, {
        isRetryable: alwaysRetry,
        initialDelayMs: 500,
        abortSignal: controller.signal,
      });
      // Abort mid-backoff, after the first failed attempt has scheduled its sleep.
      setTimeout(() => controller.abort(), 50);
      await expect(promise).rejects.toThrow('original');
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });
});
