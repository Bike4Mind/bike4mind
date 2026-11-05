// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => {
  type Middleware = (req: unknown, res: unknown, next: () => void) => unknown;
  const middlewares: Middleware[] = [];
  const pass: Middleware = (_req, _res, next) => next();
  return { middlewares, pass };
});

vi.mock('next-connect', () => ({
  default: () => {
    const router = {
      use: (...middlewares: typeof harness.middlewares) => {
        harness.middlewares.push(...middlewares);
        return router;
      },
    };
    return router;
  },
}));

vi.mock('@bike4mind/server-utils/lib/settings/registerContributedSettings', () => ({}));
vi.mock('@bike4mind/server-utils/services/gears/toolGearObserver', () => ({ registerToolGearObserver: () => {} }));
vi.mock('@bike4mind/database', () => ({ connectDB: async () => {} }));
vi.mock('@server/auth/auth', () => ({ authMiddleware: [], auth: harness.pass }));
vi.mock('@server/middlewares/logging', () => ({ logging: harness.pass }));
vi.mock('@server/middlewares/deployRevision', () => ({ deployRevision: harness.pass }));
vi.mock('@server/middlewares/errorHandler', () => ({ default: () => {} }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ apiKeyAuth: () => harness.pass }));
vi.mock('@server/middlewares/apiKeyAnomalyDetection', () => ({ apiKeyAnomalyDetection: () => harness.pass }));
vi.mock('@server/middlewares/apiKeyRateLimit', () => ({ apiKeyRateLimit: () => harness.pass }));
vi.mock('@server/middlewares/defaultWriteRateLimit', () => ({ defaultWriteRateLimit: harness.pass }));
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: () => harness.pass }));
vi.mock('@server/middlewares/oauthRouteGate', () => ({ oauthRouteGate: () => harness.pass }));
vi.mock('@server/middlewares/impersonationGate', () => ({
  impersonationGate: harness.pass,
  impersonationAnonymousGate: harness.pass,
}));
vi.mock('@server/analytics/analyticsMiddleware', () => ({ analyticsMiddleware: () => harness.pass }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://test/%STAGE%', STAGE: 'test' },
  isDevelopment: () => false,
}));

import { baseApi } from './baseApi';

describe('baseApi request logging', () => {
  beforeEach(() => {
    harness.middlewares.length = 0;
  });

  it.each([
    ['GET', '/api/auth/google?inviteCode=REF-123&redirectTo=%2F', '/api/auth/google'],
    ['POST', '/api/auth/apple/callback?state=state-token', '/api/auth/apple/callback'],
    ['GET', '/api/auth/github', '/api/auth/github'],
    ['GET', undefined, ''],
  ])('logs %s %s without query parameters', async (method, url, path) => {
    const info = vi.fn();
    const req = { method, url, headers: {}, logger: { info, withMetadata: () => ({ info }) } };
    const res = { on: vi.fn() };
    baseApi({ auth: false });

    for (const middleware of harness.middlewares) {
      const next = vi.fn();
      await middleware(req, res, next);
      expect(next).toHaveBeenCalledOnce();
    }

    expect(info).toHaveBeenCalledExactlyOnceWith(`API Request: ${method} ${path}`);
    expect(JSON.stringify(info.mock.calls)).not.toContain('inviteCode');
    expect(JSON.stringify(info.mock.calls)).not.toContain('REF-123');
    expect(JSON.stringify(info.mock.calls)).not.toContain('redirectTo');
    expect(req.url).toBe(url);
  });
});
