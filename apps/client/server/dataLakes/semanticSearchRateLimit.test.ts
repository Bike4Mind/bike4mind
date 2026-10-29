import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { TooManyRequestsError } from '@bike4mind/utils';

const { resolveTierLimit, incrementBucket } = vi.hoisted(() => ({
  resolveTierLimit: vi.fn(),
  incrementBucket: vi.fn(),
}));

vi.mock('@server/utils/userRateTier', () => ({
  resolveUserRateLimitPerMin: resolveTierLimit,
}));
vi.mock('@bike4mind/database', () => ({
  cacheRepository: { tryIncrementWithinLimitFixedWindow: incrementBucket },
}));

import { rateLimit } from '@bike4mind/server-utils/middlewares/rateLimit';
import { SEMANTIC_SEARCH_RATE_LIMIT } from './semanticSearchRateLimit';

const SEARCH_PATHS = ['/api/data-lakes/semantic-search', '/api/v1/data-lakes/lake-1/search'];
const requestFor = (url: string) => ({ url, user: { id: 'user-1' } }) as unknown as Request;

describe('shared semantic search rate limit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    incrementBucket.mockResolvedValue({ success: true, expiresAt: new Date(Date.now() + 60_000) });
  });

  it.each(SEARCH_PATHS)('blocks %s at a zero tier limit before counting or running the handler', async url => {
    resolveTierLimit.mockResolvedValue(0);
    const setHeader = vi.fn();
    const response = { setHeader } as unknown as Response;
    const next = vi.fn();

    await rateLimit(SEMANTIC_SEARCH_RATE_LIMIT)(requestFor(url), response, next);

    expect(next).toHaveBeenCalledWith(expect.any(TooManyRequestsError));
    expect(setHeader).toHaveBeenCalledWith('Retry-After', 60);
    expect(incrementBucket).not.toHaveBeenCalled();
  });

  it.each([10, 30, 60, Infinity])('preserves the shared 10/minute cap for tier limit %s', async tierLimit => {
    resolveTierLimit.mockResolvedValue(tierLimit);
    const response = { setHeader: vi.fn() } as unknown as Response;
    const next = vi.fn();

    for (const url of SEARCH_PATHS) {
      await rateLimit(SEMANTIC_SEARCH_RATE_LIMIT)(requestFor(url), response, next);
    }

    expect(incrementBucket).toHaveBeenCalledTimes(2);
    expect(incrementBucket).toHaveBeenNthCalledWith(1, 'rate-limit:user-1:/api/data-lakes/semantic-search', 10, 60_000);
    expect(incrementBucket).toHaveBeenNthCalledWith(2, 'rate-limit:user-1:/api/data-lakes/semantic-search', 10, 60_000);
    expect(next).toHaveBeenCalledTimes(2);
    expect(next).toHaveBeenNthCalledWith(1);
    expect(next).toHaveBeenNthCalledWith(2);
  });
});
