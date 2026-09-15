// @vitest-environment node
/**
 * Like defineNextRoute.test.ts and chat.integration.test.ts, this drives the
 * REAL next-connect chain `baseApi` assembles rather than a passthrough mock,
 * because what is under test here is WHICH middleware gets installed. Only
 * data/AWS edges are stubbed.
 *
 * Covers the deadlock from the self-service rate-limit PATCH issue: a key
 * already over its own limit must still be able to reach a route that opts
 * into `skipApiKeyRateLimit`, and every other route must keep enforcing the
 * limit exactly as before (including auth and scope checks, which must not be
 * affected by the exemption).
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

/** Simulates a key whose daily window is already exhausted. */
const exhausted = () =>
  mockCheckRateLimit.mockResolvedValue({
    allowed: false,
    error: 'Rate limit exceeded: 1000 requests per day.',
    retryAfter: 3600,
    limitType: 'day',
    headers: {
      'X-RateLimit-Limit-Minute': 60,
      'X-RateLimit-Remaining-Minute': 59,
      'X-RateLimit-Reset-Minute': 0,
      'X-RateLimit-Limit-Day': 1000,
      'X-RateLimit-Remaining-Day': 0,
      'X-RateLimit-Reset-Day': 0,
    },
  });

describe('baseApi skipApiKeyRateLimit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFindById.mockResolvedValue({ id: 'user-1', _id: 'user-1', isBanned: false, disputePending: false });
  });

  it('reaches the handler for an over-limit key when the route opts in - the deadlock this fixes', async () => {
    validKey();
    exhausted();
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi({ skipApiKeyRateLimit: true }).patch(handlerFn);

    const { req, res } = fire();
    await route(req, res);

    expect(res._getStatusCode()).toBe(200);
    expect(handlerFn).toHaveBeenCalledTimes(1);
    // The counter is never consulted at all - not merely overridden after the fact.
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('negative: a route WITHOUT the opt-in still 429s the same over-limit key', async () => {
    validKey();
    exhausted();
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi().patch(handlerFn);

    const { req, res } = fire();
    await route(req, res);

    expect(res._getStatusCode()).toBe(429);
    expect(handlerFn).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).toHaveBeenCalledTimes(1);
  });

  it('negative: the exemption does not widen auth - an invalid key still 401s', async () => {
    mockValidate.mockResolvedValue({ isValid: false, reason: 'not found' });
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi({ skipApiKeyRateLimit: true }).patch(handlerFn);

    const { req, res } = fire();
    await route(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(handlerFn).not.toHaveBeenCalled();
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('negative: the exemption does not widen scope - an under-scoped key still 403s', async () => {
    validKey([ApiKeyScope.READ_FILES]);
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi({ skipApiKeyRateLimit: true, requiredScopes: [ApiKeyScope.AI_CHAT] }).patch(handlerFn);

    const { req, res } = fire();
    await route(req, res);

    expect(res._getStatusCode()).toBe(403);
    expect(handlerFn).not.toHaveBeenCalled();
  });

  it('negative: a request with no key and no JWT still 401s on the exempted route', async () => {
    const handlerFn = vi.fn((_req: any, res: any) => res.status(200).json({ ok: true }));
    const route = baseApi({ skipApiKeyRateLimit: true }).patch(handlerFn);

    const { req, res } = fire({ apiKey: null });
    await route(req, res);

    expect(res._getStatusCode()).toBe(401);
    expect(handlerFn).not.toHaveBeenCalled();
  });
});
