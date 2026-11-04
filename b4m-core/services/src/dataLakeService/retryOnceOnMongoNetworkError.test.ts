import { describe, expect, it, vi } from 'vitest';
import { retryOnceOnMongoNetworkError } from './retryOnceOnMongoNetworkError';

const networkTimeout = () =>
  Object.assign(new Error('connection 1 to 10.0.0.1:27017 timed out'), { name: 'MongoNetworkTimeoutError' });

describe('retryOnceOnMongoNetworkError', () => {
  it('returns the first result without retrying', async () => {
    const read = vi.fn().mockResolvedValue(['row']);
    await expect(retryOnceOnMongoNetworkError(read, { label: 'test', delayMs: 0 })).resolves.toEqual(['row']);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('retries once after a network timeout and returns the second result', async () => {
    const read = vi.fn().mockRejectedValueOnce(networkTimeout()).mockResolvedValueOnce(['row']);
    const logger = { warn: vi.fn() };
    await expect(retryOnceOnMongoNetworkError(read, { label: 'scan', logger, delayMs: 0 })).resolves.toEqual(['row']);
    expect(read).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [message] = logger.warn.mock.calls[0];
    expect(message).toContain('scan: MongoNetworkTimeoutError');
    // The driver message carries the host address; only the name may be logged.
    expect(message).not.toContain('10.0.0.1');
  });

  it('rethrows the second network failure instead of retrying again', async () => {
    const second = networkTimeout();
    const read = vi.fn().mockRejectedValueOnce(networkTimeout()).mockRejectedValueOnce(second);
    await expect(retryOnceOnMongoNetworkError(read, { label: 'scan', delayMs: 0 })).rejects.toBe(second);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('does not retry a server selection timeout, which has already waited its full budget', async () => {
    const error = Object.assign(new Error('x'), { name: 'MongoServerSelectionError' });
    const read = vi.fn().mockRejectedValue(error);
    await expect(retryOnceOnMongoNetworkError(read, { label: 'scan', delayMs: 0 })).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('does not retry a non-network error', async () => {
    const error = Object.assign(new Error('bad query'), { name: 'MongoServerError', code: 2 });
    const read = vi.fn().mockRejectedValue(error);
    await expect(retryOnceOnMongoNetworkError(read, { label: 'scan', delayMs: 0 })).rejects.toBe(error);
    expect(read).toHaveBeenCalledTimes(1);
  });
});
