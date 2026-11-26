// @vitest-environment node
/**
 * GET /api/callable-functions/status through the real `baseApi` chain, with the session check and the
 * setting resolver stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { createMocks } from 'node-mocks-http';
import type { NextApiRequest, NextApiResponse } from 'next';

const { mockResolve, perUserBuckets, limiter, session, validateApiKey } = vi.hoisted(() => ({
  mockResolve: vi.fn(),
  perUserBuckets: [] as string[],
  limiter: { limited: false },
  session: { attachUser: true },
  validateApiKey: vi.fn(),
}));

vi.mock('@bike4mind/services', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    userApiKeyService: {
      ...(actual.userApiKeyService as object),
      validateUserApiKey: (...args: unknown[]) => validateApiKey(...args),
    },
  };
});

vi.mock('@bike4mind/server-utils/callableFunctions/access', () => ({
  resolveCallableFunctionsEnabled: (...args: unknown[]) => mockResolve(...args),
}));
vi.mock('@server/middlewares/perUserRateLimit', () => ({
  perUserRateLimit: (bucket: string) => {
    perUserBuckets.push(bucket);
    return (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) =>
      limiter.limited ? res.status(429).json({ error: 'Too many requests' }) : next();
  },
}));
vi.mock('@bike4mind/server-utils/utils/apiKeyRateLimitCheck', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  checkApiKeyRateLimit: vi.fn().mockResolvedValue({ allowed: true, headers: {} }),
}));
vi.mock('@bike4mind/server-utils/utils/analyticsLog', () => ({ logEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@bike4mind/database', async orig => ({
  ...(await orig<Record<string, unknown>>()),
  connectDB: vi.fn().mockResolvedValue(undefined),
}));

const JWT_USER = { id: 'jwt-user', _id: 'jwt-user', isBanned: false, disputePending: false };
vi.mock('@server/auth/auth', async orig => {
  const actual = await orig<Record<string, unknown>>();
  return {
    ...actual,
    auth: (
      req: { headers?: Record<string, unknown>; user?: unknown },
      res: { status: (code: number) => { json: (body: unknown) => void } },
      next: () => void
    ) => {
      if (!req.headers?.authorization) return res.status(401).json({ error: 'Unauthorized' });
      if (session.attachUser && !req.user) req.user = JWT_USER;
      next();
    },
  };
});

import handler from '../status';

type HandlerArgs = Parameters<typeof handler>;

function fire(bearer?: string, extraHeaders: Record<string, string> = {}) {
  const { req, res } = createMocks<NextApiRequest, NextApiResponse>(
    {
      method: 'GET',
      url: '/api/callable-functions/status',
      headers: { ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extraHeaders },
    },
    { eventEmitter: EventEmitter }
  );
  const call = () => handler(req as unknown as HandlerArgs[0], res as unknown as HandlerArgs[1]);
  return { res, call };
}

describe('GET /api/callable-functions/status', () => {
  beforeEach(() => {
    mockResolve.mockReset();
    mockResolve.mockResolvedValue(false);
    limiter.limited = false;
    session.attachUser = true;
    validateApiKey.mockReset();
    validateApiKey.mockResolvedValue({ isValid: false, reason: 'not_found' });
  });

  it('answers 401 to an API key without validating it, since the route takes a session only', async () => {
    const { res, call } = fire(undefined, { 'x-api-key': 'b4m_live_0123456789abcdef0123456789abcdef' });
    await call();

    expect(res._getStatusCode()).toBe(401);
    expect(validateApiKey).not.toHaveBeenCalled();
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('answers 401 without a session and never reads the setting', async () => {
    const { res, call } = fire();
    await call();

    expect(res._getStatusCode()).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('answers 401 if the session middleware leaves the request without an identity', async () => {
    session.attachUser = false;
    const { res, call } = fire('live-jwt');
    await call();

    expect(res._getStatusCode()).toBe(401);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('answers { enabled: false } by default', async () => {
    const { res, call } = fire('live-jwt');
    await call();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ enabled: false });
    expect(mockResolve).toHaveBeenCalledWith(expect.objectContaining({ id: 'jwt-user' }));
    expect(perUserBuckets).toEqual(['GET /api/callable-functions/status']);
  });

  it('answers { enabled: true } when the resolver says so, and no server runtime on a stage without one', async () => {
    vi.stubEnv('CALLABLE_FUNCTION_RUNTIME_FUNCTION_NAME', '');
    vi.stubEnv('CALLABLE_FUNCTION_CHILD_PATH', '');
    mockResolve.mockResolvedValue(true);
    const { res, call } = fire('live-jwt');
    await call();
    vi.unstubAllEnvs();

    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ enabled: true, serverRuntime: false });
  });

  it('reports the server runtime when the stage names one', async () => {
    vi.stubEnv('CALLABLE_FUNCTION_RUNTIME_FUNCTION_NAME', 'runtime-fn');
    mockResolve.mockResolvedValue(true);
    const { res, call } = fire('live-jwt');
    await call();
    vi.unstubAllEnvs();

    expect(res._getJSONData()).toEqual({ enabled: true, serverRuntime: true });
  });

  it('runs the per-user limiter before reading the setting', async () => {
    limiter.limited = true;
    const { res, call } = fire('live-jwt');
    await call();

    expect(res._getStatusCode()).toBe(429);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  it('answers 500 when the setting cannot be read', async () => {
    mockResolve.mockRejectedValue(new Error('overlay unavailable'));
    const { res, call } = fire('live-jwt');
    await call();

    expect(res._getStatusCode()).toBe(500);
  });
});
