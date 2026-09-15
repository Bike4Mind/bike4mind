import { describe, it, expect, beforeEach, vi } from 'vitest';
import { checkEmbedSessionRateLimit } from './embedSessionRateLimit';
import { cacheRepository } from '@bike4mind/database';

vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: vi.fn(),
    decrementCounter: vi.fn(),
  },
}));

const tryIncrement = vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow);
const decrement = vi.mocked(cacheRepository.decrementCounter);
const future = (ms: number) => new Date(Date.now() + ms);
const limits = { requestsPerMinute: 5, requestsPerDay: 100 };

describe('checkEmbedSessionRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    decrement.mockResolvedValue(0);
  });

  it('allows a request under both windows and keys on the embed-session namespace', async () => {
    tryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: future(60_000) });

    const result = await checkEmbedSessionRateLimit('sess-1', limits);

    expect(result.allowed).toBe(true);
    expect(tryIncrement).toHaveBeenCalledWith('embed-session-rate-limit:sess-1:minute', 5, 60_000);
    expect(tryIncrement).toHaveBeenCalledWith('embed-session-rate-limit:sess-1:day', 100, 86_400_000);
  });

  it('rejects on the minute limit without touching the day counter', async () => {
    tryIncrement.mockResolvedValueOnce({ success: false, count: 6, expiresAt: future(30_000) });

    const result = await checkEmbedSessionRateLimit('sess-1', limits);

    expect(result.allowed).toBe(false);
    expect(result.retryAfter).toBe(30);
    expect(tryIncrement).toHaveBeenCalledTimes(1); // day counter never incremented
    expect(decrement).not.toHaveBeenCalled();
  });

  it('rolls back the minute increment when the day limit is exceeded', async () => {
    tryIncrement
      .mockResolvedValueOnce({ success: true, count: 1, expiresAt: future(60_000) })
      .mockResolvedValueOnce({ success: false, count: 101, expiresAt: future(3_600_000) });

    const result = await checkEmbedSessionRateLimit('sess-1', limits);

    expect(result.allowed).toBe(false);
    expect(decrement).toHaveBeenCalledWith('embed-session-rate-limit:sess-1:minute');
  });
});
