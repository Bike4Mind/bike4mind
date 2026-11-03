import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isTransportError, retryTransportErrors } from './transportRetry';

const logger = { warn: vi.fn() } as unknown as Parameters<typeof retryTransportErrors>[1]['logger'];
const fetchFailed = () =>
  new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'ECONNRESET' }) });

describe('isTransportError', () => {
  it('matches only the undici TypeErrors', () => {
    expect(isTransportError(fetchFailed())).toBe(true);
    expect(isTransportError(new TypeError('terminated'))).toBe(true);
    expect(isTransportError(new Error('fetch failed'))).toBe(false);
    expect(isTransportError(new TypeError('other'))).toBe(false);
    expect(isTransportError('fetch failed')).toBe(false);
  });
});

describe('retryTransportErrors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(logger.warn).mockClear();
  });
  afterEach(() => vi.useRealTimers());

  const run = async <T>(open: () => Promise<T>, abortSignal?: AbortSignal) => {
    const result = retryTransportErrors(open, { logger, label: 'Test', abortSignal });
    const settled = result.then(
      value => ({ value }),
      error => ({ error })
    );
    await vi.runAllTimersAsync();
    return settled;
  };

  it('returns the first success without logging', async () => {
    const open = vi.fn().mockResolvedValue('ok');
    expect(await run(open)).toEqual({ value: 'ok' });
    expect(open).toHaveBeenCalledTimes(1);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('retries a transport error and then succeeds', async () => {
    const open = vi.fn().mockRejectedValueOnce(fetchFailed()).mockResolvedValue('ok');
    expect(await run(open)).toEqual({ value: 'ok' });
    expect(open).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('gives up after two retries and rethrows the original error', async () => {
    const err = fetchFailed();
    const open = vi.fn().mockRejectedValue(err);
    expect(await run(open)).toEqual({ error: err });
    expect(open).toHaveBeenCalledTimes(3);
  });

  it('does not retry any other error', async () => {
    const err = new Error('429 rate limit');
    const open = vi.fn().mockRejectedValue(err);
    expect(await run(open)).toEqual({ error: err });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not reopen when the request is aborted during the backoff sleep', async () => {
    const err = fetchFailed();
    const open = vi.fn().mockRejectedValue(err);
    const controller = new AbortController();
    const settled = retryTransportErrors(open, { logger, label: 'Test', abortSignal: controller.signal }).then(
      value => ({ value }),
      error => ({ error })
    );

    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.runAllTimersAsync();

    expect(await settled).toEqual({ error: err });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('does not retry once the request was aborted', async () => {
    const err = fetchFailed();
    const open = vi.fn().mockRejectedValue(err);
    const controller = new AbortController();
    controller.abort();
    expect(await run(open, controller.signal)).toEqual({ error: err });
    expect(open).toHaveBeenCalledTimes(1);
  });
});
