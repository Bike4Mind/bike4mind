import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAbortAwareRetrySignal, retryAbortAware } from './abortAwareRetry';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('abort-aware retry', () => {
  it('requires a signal and a supported call shape when opted in', () => {
    expect(getAbortAwareRetrySignal({ stream: true })).toBeUndefined();
    expect(() => getAbortAwareRetrySignal({ retryMode: 'abort-aware', stream: false })).toThrow(/signal/);
    expect(() =>
      getAbortAwareRetrySignal({
        retryMode: 'abort-aware',
        stream: true,
        abortSignal: new AbortController().signal,
      })
    ).toThrow(/non-streaming/);
  });

  it.each([0, -1, 1.5, NaN, Infinity])('rejects an invalid attempt limit of %s before dispatch', async maxAttempts => {
    const dispatch = vi.fn();
    await expect(retryAbortAware(dispatch, new AbortController().signal, { maxAttempts })).rejects.toBeInstanceOf(
      RangeError
    );
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('never starts an already-aborted request', async () => {
    const reason = new Error('expired');
    const dispatch = vi.fn();
    await expect(retryAbortAware(dispatch, AbortSignal.abort(reason))).rejects.toBe(reason);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it.each([
    ['Retry-After', '12', 12_000],
    ['retry-after', 'Tue, 24 Nov 2026 12:00:20 GMT', 20_000],
    ['retry-after-ms', '1500', 1_500],
  ] as const)('waits the full %s hint %s before retrying', async (name, hint, delay) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-24T12:00:00Z'));
    const dispatch = vi
      .fn()
      .mockRejectedValueOnce({ status: 429, headers: { [name]: hint } })
      .mockResolvedValueOnce('second attempt');
    const random = vi.spyOn(Math, 'random').mockReturnValue(0);
    const onRetry = vi.fn();
    const pending = retryAbortAware(dispatch, new AbortController().signal, { onRetry });
    await vi.advanceTimersByTimeAsync(delay - 1);
    expect(dispatch).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe('second attempt');
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledExactlyOnceWith({ error: expect.any(Error), delayMs: delay });
    expect(random).not.toHaveBeenCalled();
  });

  it.each([
    [0, 375],
    [0.5, 500],
    [0.999, 625],
  ])('jitters the local backoff with a random sample of %s', async (sample, delayMs) => {
    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(sample);
    const error = Object.assign(new Error('unavailable'), { status: 503 });
    const dispatch = vi.fn().mockRejectedValueOnce(error).mockResolvedValueOnce('retried');
    const onRetry = vi.fn();
    const result = retryAbortAware(dispatch, new AbortController().signal, { onRetry });

    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(onRetry).toHaveBeenCalledExactlyOnceWith({ error, delayMs });
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe('retried');
  });

  it('isolates a failed retry observer from dispatch and does not notify on terminal failure', async () => {
    vi.useFakeTimers();
    const error = Object.assign(new Error('unavailable'), { status: 503 });
    const dispatch = vi.fn().mockRejectedValue(error);
    const onRetry = vi.fn(() => {
      throw new Error('observer failed');
    });
    const result = retryAbortAware(dispatch, new AbortController().signal, { maxAttempts: 2, onRetry }).catch(
      err => err
    );
    await vi.runAllTimersAsync();
    expect(await result).toBe(error);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('wakes before a long Retry-After expires and never sends a second request', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const dispatch = vi.fn().mockRejectedValue({ status: 429, headers: { 'Retry-After': '3600' } });
    const result = retryAbortAware(dispatch, controller.signal).catch(error => error);
    await vi.advanceTimersByTimeAsync(1);
    controller.abort();
    await expect(result).resolves.toMatchObject({ name: 'AbortError' });
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('limits retries to two and preserves the final provider error', async () => {
    vi.useFakeTimers();
    const final = { status: 503, message: 'unavailable' };
    const dispatch = vi.fn().mockRejectedValue(final);
    const result = retryAbortAware(dispatch, new AbortController().signal).catch(error => error);
    await vi.runAllTimersAsync();
    expect(await result).toBe(final);
    expect(dispatch).toHaveBeenCalledTimes(3);
  });

  it('honors a provider instruction against retry', async () => {
    const error = { status: 503, headers: { 'x-should-retry': 'false' } };
    const dispatch = vi.fn().mockRejectedValue(error);
    await expect(retryAbortAware(dispatch, new AbortController().signal)).rejects.toBe(error);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it('joins the original provider promise after abort, including a genuinely returned response', async () => {
    const controller = new AbortController();
    const transport = Promise.withResolvers<string>();
    const settled = vi.fn();
    const pending = retryAbortAware(() => transport.promise, controller.signal).then(settled);
    controller.abort();
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    transport.resolve('actual response');
    await pending;
    expect(settled).toHaveBeenCalledWith('actual response');
  });
});

describe('single-attempt admission', () => {
  it('requires an explicitly supported adapter and the existing cancellable text shape', () => {
    const signal = new AbortController().signal;
    const options = { retryMode: 'single-attempt' as const, stream: false, abortSignal: signal };
    expect(() => getAbortAwareRetrySignal(options)).toThrow(/unsupported/);
    expect(getAbortAwareRetrySignal(options, true)).toBe(signal);
    expect(() => getAbortAwareRetrySignal({ ...options, stream: true }, true)).toThrow(/non-streaming/);
    expect(() => getAbortAwareRetrySignal({ ...options, tools: [{} as never] }, true)).toThrow(/without tools/);
    expect(() => getAbortAwareRetrySignal({ ...options, abortSignal: undefined }, true)).toThrow(/signal/);
  });
});
