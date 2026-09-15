import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TooManyRequestsError } from '@bike4mind/utils';
import { cacheRepository } from '@bike4mind/database';

/**
 * The counter a route is metered against, exercised through the real middleware
 * and the real enforcer over an in-memory stand-in for the cache. The case that
 * matters: a key at its daily ceiling must still be able to call the
 * management-metered route that raises that ceiling.
 */

const store = new Map<string, { count: number; expiresAt: Date }>();

vi.mock('@bike4mind/database', () => ({
  cacheRepository: {
    tryIncrementWithinLimitFixedWindow: vi.fn(async (key: string, limit: number, ttlMs: number) => {
      const existing = store.get(key);
      const window = existing && existing.expiresAt.getTime() > Date.now() ? existing : undefined;
      const count = window?.count ?? 0;
      const expiresAt = window?.expiresAt ?? new Date(Date.now() + ttlMs);
      if (count >= limit) return { success: false, count, expiresAt };
      store.set(key, { count: count + 1, expiresAt });
      return { success: true, count: count + 1, expiresAt };
    }),
    decrementCounter: vi.fn(async (key: string) => {
      const existing = store.get(key);
      if (!existing) return 0;
      existing.count -= 1;
      return existing.count;
    }),
    findByKey: vi.fn(async (key: string) => {
      const existing = store.get(key);
      return existing ? { result: { count: existing.count }, expiresAt: existing.expiresAt } : null;
    }),
    deleteByKey: vi.fn(),
  },
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@server/utils/cloudwatch', () => ({ emitMetric: vi.fn().mockResolvedValue(undefined) }));

import { apiKeyRateLimit } from './apiKeyRateLimit';
import { buildRateLimitKeys } from '@server/utils/apiKeyRateLimitCheck';

const KEY_ID = 'key-1';
const DAY_MS = 86_400_000;
const rateLimit = { requestsPerMinute: 60, requestsPerDay: 10 };

/** Put the key's request-quota day counter at its ceiling. */
function exhaustDailyQuota() {
  const { dayKey } = buildRateLimitKeys(KEY_ID);
  store.set(dayKey, { count: rateLimit.requestsPerDay, expiresAt: new Date(Date.now() + DAY_MS) });
}

function patchRequest() {
  const res = { setHeader: vi.fn() };
  const req = {
    method: 'PATCH',
    url: '/api/user-api-keys/key-1/rate-limit',
    user: { id: 'u1' },
    apiKeyInfo: { keyId: KEY_ID, rateLimit },
  };
  return { req, res };
}

async function run(middleware: ReturnType<typeof apiKeyRateLimit>, req: unknown, res: unknown) {
  return new Promise<unknown>(resolve => {
    (middleware as (req: unknown, res: unknown, next: (err?: unknown) => void) => void)(req, res, resolve);
  });
}

describe('apiKeyRateLimit counter selection', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('allows a management-metered PATCH from a key whose own daily window is exhausted', async () => {
    exhaustDailyQuota();
    const { req, res } = patchRequest();

    const err = await run(apiKeyRateLimit({ counter: 'management' }), req, res);

    expect(err).toBeUndefined();
    // The exhausted request-quota counter was neither consulted nor advanced.
    const { dayKey } = buildRateLimitKeys(KEY_ID);
    expect(store.get(dayKey)!.count).toBe(rateLimit.requestsPerDay);
    expect(store.get(buildRateLimitKeys(KEY_ID, 'management').dayKey)!.count).toBe(1);
  });

  it('rejects the same PATCH when it is metered against the key request quota', async () => {
    exhaustDailyQuota();
    const { req, res } = patchRequest();

    const err = await run(apiKeyRateLimit(), req, res);

    expect(err).toBeInstanceOf(TooManyRequestsError);
  });

  it('leaves an ordinary route on the key request quota by default', async () => {
    const { req, res } = patchRequest();

    await run(apiKeyRateLimit(), req, res);

    expect(vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow).mock.calls.map(call => call[0])).toEqual([
      buildRateLimitKeys(KEY_ID).minuteKey,
      buildRateLimitKeys(KEY_ID).dayKey,
    ]);
  });
});
