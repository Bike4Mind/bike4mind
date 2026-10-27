import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TooManyRequestsError } from '@bike4mind/utils';
import { cacheRepository } from '@bike4mind/database';
import { ApiKeyScope } from '@bike4mind/common';
import { emitMetric } from '@bike4mind/server-utils/utils/cloudwatch';

/**
 * The counter a route is metered against, exercised through the real middleware
 * and the real enforcer over an in-memory stand-in for the cache. The case that
 * matters: a key at its daily ceiling must still be able to call the
 * management-metered route that raises that ceiling.
 */

const store = new Map<string, { count: number; expiresAt: Date }>();

const { loadShadowTierSettingsMock } = vi.hoisted(() => ({
  loadShadowTierSettingsMock: vi.fn(async () => ({ requestsPerMin: 3 })),
}));
vi.mock('@bike4mind/services/llm/shadowTier', () => ({ loadShadowTierSettings: loadShadowTierSettingsMock }));

vi.mock('@bike4mind/database', () => ({
  adminSettingsRepository: {},
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
vi.mock('@bike4mind/server-utils/utils/cloudwatch', () => ({ emitMetric: vi.fn().mockResolvedValue(undefined) }));

import { withholdAdminRole } from '@server/auth/apiKeyAdminScope';
import { apiKeyRateLimit } from './apiKeyRateLimit';
import { rateLimit as rateLimitMiddleware } from './rateLimit';
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

describe('apiKeyRateLimit response headers', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  it('sets exactly the six windowed rate-limit headers, plus Retry-After on a 429', async () => {
    // Hardcoded on purpose: the middleware loops over the shared constant, so a
    // renamed or dropped entry there would otherwise pass unnoticed.
    const expected = [
      'X-RateLimit-Limit-Minute',
      'X-RateLimit-Remaining-Minute',
      'X-RateLimit-Reset-Minute',
      'X-RateLimit-Limit-Day',
      'X-RateLimit-Remaining-Day',
      'X-RateLimit-Reset-Day',
    ];

    const ok = patchRequest();
    await run(apiKeyRateLimit(), ok.req, ok.res);
    const okHeaders = ok.res.setHeader.mock.calls.map(call => call[0]);
    expect(okHeaders).toEqual(expected);
    for (const call of ok.res.setHeader.mock.calls) {
      expect(Number.isInteger(call[1])).toBe(true);
    }
    expect(ok.res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit-Minute', rateLimit.requestsPerMinute);
    expect(ok.res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit-Day', rateLimit.requestsPerDay);

    exhaustDailyQuota();
    const limited = patchRequest();
    const err = await run(apiKeyRateLimit(), limited.req, limited.res);
    expect(err).toBeInstanceOf(TooManyRequestsError);
    expect(limited.res.setHeader.mock.calls.map(call => call[0])).toEqual([...expected, 'Retry-After']);
  });
});

describe('apiKeyRateLimit overwatch RateLimitHit metric', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  // The 429 ends the invocation; a still-pending emit is lost when the Lambda freezes, or sent on a
  // later thaw with an expired SigV4 signature.
  it('does not pass the 429 on until the RateLimitHit metric has been emitted', async () => {
    exhaustDailyQuota();
    const { req, res } = patchRequest();
    const ingestReq = {
      ...req,
      apiKeyInfo: { ...req.apiKeyInfo, scopes: [ApiKeyScope.OVERWATCH_INGEST_WRITE], productId: 'prod-1' },
    };
    let releaseEmit: () => void = () => {};
    vi.mocked(emitMetric).mockReturnValueOnce(
      new Promise<void>(resolve => {
        releaseEmit = resolve;
      })
    );

    let nextCalled = false;
    const result = run(apiKeyRateLimit(), ingestReq, res).then(err => {
      nextCalled = true;
      return err;
    });
    await vi.waitFor(() => expect(emitMetric).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(nextCalled).toBe(false);

    releaseEmit();
    expect(await result).toBeInstanceOf(TooManyRequestsError);
    expect(emitMetric).toHaveBeenCalledWith(
      'Lumina5/OverwatchIngest',
      'RateLimitHit',
      1,
      { productId: 'prod-1' },
      expect.anything()
    );
  });
});

describe('apiKeyRateLimit restricted-tier owner', () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  const withOwner = (user: Record<string, unknown>) => {
    const { req, res } = patchRequest();
    return { req: { ...req, user: { id: 'u1', ...user } }, res };
  };

  it('advertises the key limits, not the restricted-tier rpm', async () => {
    const { req, res } = withOwner({ throttle: { tier: 'shadow' } });

    await run(apiKeyRateLimit(), req, res);

    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit-Minute', rateLimit.requestsPerMinute);
    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit-Day', rateLimit.requestsPerDay);
  });

  it('exempts a stored admin whose API key withholds the admin role', async () => {
    const { req, res } = withOwner({ isAdmin: true, throttle: { tier: 'shadow' } });
    const owner = req.user as typeof req.user & { isAdmin: boolean };
    withholdAdminRole(owner);
    expect(owner.isAdmin).toBe(false);

    expect(await run(apiKeyRateLimit(), req, res)).toBeUndefined();

    expect(loadShadowTierSettingsMock).not.toHaveBeenCalled();
    expect(vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)).toHaveBeenCalledTimes(2);
  });

  it('makes no extra cache call for other owners', async () => {
    const { req, res } = withOwner({ throttle: { tier: 'none' } });

    await run(apiKeyRateLimit(), req, res);

    expect(res.setHeader).toHaveBeenCalledWith('X-RateLimit-Limit-Minute', rateLimit.requestsPerMinute);
    expect(loadShadowTierSettingsMock).not.toHaveBeenCalled();
    expect(vi.mocked(cacheRepository.tryIncrementWithinLimitFixedWindow)).toHaveBeenCalledTimes(2);
  });

  it("returns the owner's per-user tier 429 once over the restricted rpm, keeping the key's headers", async () => {
    vi.useFakeTimers();
    try {
      const shadow = withOwner({ throttle: { tier: 'shadow' } });
      shadow.req.apiKeyInfo = { keyId: 'key-a', rateLimit: { ...rateLimit, requestsPerDay: 1000 } };
      let shadowErr: unknown;
      // Shadow rpm mock is 3; the key allows 60.
      for (let i = 0; i < 4; i++) {
        shadow.res.setHeader.mockClear();
        shadowErr = await run(apiKeyRateLimit(), shadow.req, shadow.res);
      }

      const normal = withOwner({ id: 'u2' });
      const tierLimit = rateLimitMiddleware({ limit: 3, windowMs: 60_000, bucket: 'route' });
      let normalErr: unknown;
      for (let i = 0; i < 4; i++) {
        normal.res.setHeader.mockClear();
        normalErr = await run(tierLimit, normal.req, normal.res);
      }

      expect(shadowErr).toBeInstanceOf(TooManyRequestsError);
      expect((shadowErr as TooManyRequestsError).statusCode).toBe((normalErr as TooManyRequestsError).statusCode);
      expect((shadowErr as TooManyRequestsError).message).toBe((normalErr as TooManyRequestsError).message);
      const header = (res: typeof shadow.res, name: string) => res.setHeader.mock.calls.find(c => c[0] === name)?.[1];
      expect(header(shadow.res, 'Retry-After')).toBe(header(normal.res, 'Retry-After'));
      expect(shadow.res.setHeader.mock.calls.filter(c => c[0] === 'X-RateLimit-Remaining-Minute')).toEqual([
        ['X-RateLimit-Remaining-Minute', rateLimit.requestsPerMinute - 4],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});
