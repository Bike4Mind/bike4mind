// @vitest-environment node
/**
 * Like defineNextRoute.test.ts and chat.integration.test.ts, this drives the
 * REAL next-connect chain `baseApi` assembles rather than a passthrough mock,
 * because what is under test here is WHICH middleware gets installed and with
 * WHAT options. Only data/AWS edges are stubbed - including the two
 * fire-and-forget usage/anomaly writers that apiKeyAuth hangs off the response
 * 'finish' event.
 *
 * Covers the deadlock from the self-service rate-limit PATCH issue: a key
 * already over its own DAILY limit must still be able to reach a route that
 * opts into `exemptFromDailyRateLimit`, but the per-minute BURST cap must stay
 * enforced there too - the burst cap self-heals within a minute so it never
 * deadlocks a caller, and dropping it would leave the route completely
 * unthrottled. Every other route must keep enforcing both counters exactly as
 * before (including auth and scope checks, which must not be affected by the
 * exemption).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';

const { mockValidate, mockFindById, mockCheckRateLimit } = vi.hoisted(() => ({
  mockValidate: vi.fn(),
  mockFindById: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock('@server/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
}));

vi.mock('@server/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));

// Both of these are fire-and-forget hooks apiKeyAuth/apiKeyAnomalyDetection
// register on the response 'finish' event, and both write to Mongo. Left real
// they would queue a mongoose op against the stubbed connectDB and only settle
// on the 10s buffer timeout, well after the test that spawned them has ended.
vi.mock('@server/managers/apiKeyUsageManager', () => ({
  ApiKeyUsageManager: { logUsage: vi.fn().mockResolvedValue(undefined) },
}));
vi.mock('@server/managers/apiKeyAlertService', () => ({
  ApiKeyAlertService: { detectAnomalies: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...a: unknown[]) => mockValidate(...a),
    },
  };
});

vi.mock('@bike4mind/database', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const RealUser = actual.User as Record<string, unknown>;
  return {
    ...actual,
    connectDB: vi.fn().mockResolvedValue(undefined),
    User: Object.assign(Object.create(RealUser), { findById: (...a: unknown[]) => mockFindById(...a) }),
  };
});

// No JWT in these fixtures - every request authenticates via API key, so a
// caller who never gets past apiKeyAuth also never gets a JWT fallback.
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  const nc = (await import('next-connect')).default;
  const authRouter = nc<any, any>().use((req: any, _res: any, next: any) => {
    if (req.user) return next();
    next(new UnauthorizedError('Unauthorized'));
  });
  return { ...actual, auth: authRouter };
});

import { baseApi } from './baseApi';
import { ApiKeyScope } from '@bike4mind/common';
import { UnauthorizedError } from '@server/utils/errors';

const VALID_KEY = 'b4m_live_test_key';

function fire({
  apiKey = VALID_KEY as string | null,
  method = 'PATCH' as string,
}: { apiKey?: string | null; method?: string } = {}) {
  const body = { requestsPerDay: 5000 };
  const payload = JSON.stringify(body);
  const { req, res } = createMocks(
    {
      method: method as 'PATCH',
      url: '/api/fixture',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(payload)),
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
      },
      body,
    },
    { eventEmitter: EventEmitter }
  );
  return { req: req as any, res: res as any };
}

const validKey = (scopes: ApiKeyScope[] = [ApiKeyScope.AI_CHAT]) =>
  mockValidate.mockResolvedValue({
    isValid: true,
    keyId: 'k1',
    userId: 'user-1',
    scopes,
    rateLimit: { requestsPerMinute: 60, requestsPerDay: 1000 },
  });

const RATE_LIMIT_HEADERS = {
  'X-RateLimit-Limit-Minute': 60,
  'X-RateLimit-Remaining-Minute': 59,
  'X-RateLimit-Reset-Minute': 0,
  'X-RateLimit-Limit-Day': 1000,
  'X-RateLimit-Remaining-Day': 0,
  'X-RateLimit-Reset-Day': 0,
};

/** Simulates a key that is allowed through (used for the day-exempt success case). */
const allowed = () => mockCheckRateLimit.mockResolvedValue({ allowed: true, headers: RATE_LIMIT_HEADERS });

/** Simulates a key whose daily window is already exhausted. */
const exhaustedDaily = () =>
  mockCheckRateLimit.mockResolvedValue({
    allowed: false,
    error: 'Rate limit exceeded: 1000 requests per day.',
    retryAfter: 3600,
    limitType: 'day',
    headers: RATE_LIMIT_HEADERS,
  });

/** Simulates a key whose per-minute burst window is already exhausted. */
const exhaustedMinute = () =>
  mockCheckRateLimit.mockResolvedValue({
    allowed: false,
    error: 'Rate limit exceeded: 60 requests per minute.',
    retryAfter: 30,
    limitType: 'minute',
    headers: RATE_LIMIT_HEADERS,
  });

describe('baseApi exemptFromDailyRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false });
  });

  it('reaches the handler for a daily-exhausted key when the route opts in - the deadlock this fixes', async () => {
    validKey();
    allowed();
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi({ exemptFromDailyRateLimit: true }).patch(handlerFn);

    const { req, res } = fire();
    await route(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(handlerFn).toHaveBeenCalledTimes(1);
    // The middleware stays installed - it is asked to skip only the day counter.
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), {
      meterDailyLimit: false,
    });
  });

  it('still 429s a burst-exhausted key on the exempt route - the burst cap is not dropped', async () => {
    validKey();
    exhaustedMinute();
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi({ exemptFromDailyRateLimit: true }).patch(handlerFn);

    const { req, res } = fire();
    await route(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(handlerFn).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), {
      meterDailyLimit: false,
    });
  });

  it('negative: a route WITHOUT the opt-in still 429s a daily-exhausted key', async () => {
    validKey();
    exhaustedDaily();
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi().patch(handlerFn);

    const { req, res } = fire();
    await route(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(handlerFn).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), {
      meterDailyLimit: true,
    });
  });

  it('negative: the exemption does not widen auth - an invalid key still 401s', async () => {
    mockValidate.mockResolvedValue({ isValid: false, reason: 'not found' });
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi({ exemptFromDailyRateLimit: true }).patch(handlerFn);

    const { req, res } = fire();
    await route(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(handlerFn).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('negative: the exemption does not widen scope - an under-scoped key still 403s', async () => {
    validKey([ApiKeyScope.READ_FILES]);
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi({ exemptFromDailyRateLimit: true, requiredScopes: [ApiKeyScope.AI_CHAT] }).patch(handlerFn);

    const { req, res } = fire();
    await route(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it('negative: a request with no key and no JWT still 401s on the exempted route', async () => {
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi({ exemptFromDailyRateLimit: true }).patch(handlerFn);

    const { req, res } = fire({ apiKey: null });
    await route(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(handlerFn).not.toHaveBeenCalled();
  });
});
