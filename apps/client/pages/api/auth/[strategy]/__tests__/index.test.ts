import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import type { NextFunction, Request, RequestHandler, Response } from 'express';

const h = vi.hoisted(() => ({
  isBlocked: vi.fn(),
  tryIncrement: vi.fn(),
  authenticate: vi.fn(),
  turnstile: vi.fn(),
  fixedLimitOptions: [] as unknown[],
  used: [] as unknown[],
  getHandler: null as null | ((req: Request, res: Response, next: NextFunction) => unknown),
}));

// Run the real middleware in registration order, then the get handler, like baseApi's chain.
vi.mock('@server/middlewares/baseApi', () => {
  type Chain = { use: (fn: unknown) => Chain; get: (fn: RequestHandler) => Chain };
  const chain: Chain = {
    use: fn => {
      h.used.push(fn);
      return chain;
    },
    get: fn => {
      h.getHandler = async (req, res, next) => {
        for (const mw of h.used as RequestHandler[]) {
          let proceed = false;
          await mw(req, res, (err?: unknown) => {
            if (err) throw err;
            proceed = true;
          });
          if (!proceed) return;
        }
        return fn(req, res, next);
      };
      return chain;
    },
  };
  return { baseApi: () => chain };
});
vi.mock('@bike4mind/database', () => ({
  blockedIPRepository: { isBlocked: h.isBlocked },
  adminSettingsRepository: {},
  cacheRepository: { tryIncrementWithinLimitFixedWindow: h.tryIncrement },
}));
vi.mock('@bike4mind/utils', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/utils')>()),
  getSettingsMap: async () => ({}),
}));
vi.mock('@bike4mind/server-utils/utils/ip', () => ({ getClientIp: () => '203.0.113.7' }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({ isE2EEnabled: () => false }));
vi.mock('@server/auth/auth', () => ({ default: { authenticate: (...a: unknown[]) => h.authenticate(...a) } }));
vi.mock('@bike4mind/server-utils/auth/oauthFlowCookie', () => ({ issueStateNonce: () => 'hash' }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({
  rateLimit: (options: unknown) => {
    h.fixedLimitOptions.push(options);
    return (req: Request, res: Response, next: NextFunction) => next();
  },
}));
vi.mock('@server/utils/auth/oauthStartTurnstile', () => ({
  requireOAuthStartTurnstile: () => (req: Request, res: Response, next: NextFunction) => {
    h.turnstile();
    next();
  },
}));
vi.mock('@server/utils/validators', () => ({ isLocalAppUrl: () => false }));

import '@pages/api/auth/[strategy]/index';

function run() {
  const { req, res } = createMocks<Request, Response>({
    method: 'GET',
    query: { strategy: 'google' },
    headers: { host: 'localhost:3000' },
    url: '/api/auth/google',
  });
  return { req, res };
}

describe('GET /api/auth/[strategy] initiation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.tryIncrement.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
    h.authenticate.mockReturnValue(vi.fn());
  });

  it('never reaches the provider for a blocked IP', async () => {
    h.isBlocked.mockResolvedValue({ reason: 'x', expiresAt: new Date() });
    const { req, res } = run();
    await h.getHandler!(req, res, vi.fn());
    expect(res._getRedirectUrl()).toBe('/login?error=ip_blocked');
    expect(h.authenticate).not.toHaveBeenCalled();
  });

  it('never reaches the provider for an IP over the per-IP limit', async () => {
    h.isBlocked.mockResolvedValue(null);
    h.tryIncrement.mockResolvedValue({ success: false, count: 41, expiresAt: new Date(Date.now() + 60_000) });
    const { req, res } = run();
    await h.getHandler!(req, res, vi.fn());
    expect(res._getRedirectUrl()).toBe('/login?error=oauth_rate_limited');
    expect(h.authenticate).not.toHaveBeenCalled();
    // Turnstile sits after the limiter so an unsolved challenge cannot drive unbounded siteverify calls.
    expect(h.turnstile).not.toHaveBeenCalled();
  });

  it('starts the provider flow for an IP that is neither blocked nor limited', async () => {
    h.isBlocked.mockResolvedValue(null);
    const { req, res } = run();
    await h.getHandler!(req, res, vi.fn());
    expect(h.turnstile).toHaveBeenCalledTimes(1);
    expect(h.authenticate).toHaveBeenCalledWith('google', expect.objectContaining({ scope: ['profile', 'email'] }));
  });

  it('keeps the fixed per-IP burst limit in one bucket shared by every provider', () => {
    expect(h.fixedLimitOptions).toContainEqual({ limit: 10, windowMs: 60 * 1000, bucket: 'oauth-start' });
  });
});
