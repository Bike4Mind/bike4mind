// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Wiring guard: baseApi mounts defaultWriteRateLimit on authenticated routes, after the OAuth gate
 * (so a request a gate refuses never spends the user's write budget), and leaves it off routes that
 * opt out or are unauthenticated. The limiter's own logic is in defaultWriteRateLimit.test.ts. Same
 * recorder harness as baseApi.oauthGate.test.ts.
 */

const h = vi.hoisted(() => {
  const useCalls: unknown[] = [];
  const GATE_SENTINEL = () => {};
  const WRITE_LIMIT_SENTINEL = () => {};
  return { useCalls, GATE_SENTINEL, WRITE_LIMIT_SENTINEL };
});

vi.mock('next-connect', () => ({
  default: () => {
    type Recorder = { use: (...mw: unknown[]) => Recorder };
    const router: Recorder = {
      use: (...mw: unknown[]) => {
        h.useCalls.push(...mw);
        return router;
      },
    };
    return router;
  },
}));

vi.mock('@server/middlewares/defaultWriteRateLimit', () => ({ defaultWriteRateLimit: h.WRITE_LIMIT_SENTINEL }));
vi.mock('@server/middlewares/oauthRouteGate', () => ({ oauthRouteGate: () => h.GATE_SENTINEL }));
vi.mock('@server/auth/auth', () => ({ authMiddleware: [], auth: () => {} }));

// Stubbed only to keep baseApi loadable and side-effect-free.
vi.mock('@bike4mind/server-utils/services/gears/toolGearObserver', () => ({ registerToolGearObserver: () => {} }));
vi.mock('@client/lib/settings/registerContributedSettings', () => ({}));
vi.mock('@server/middlewares/logging', () => ({ logging: () => {} }));
vi.mock('@server/middlewares/errorHandler', () => ({ default: () => {} }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ apiKeyAuth: () => () => {} }));
vi.mock('@server/middlewares/apiKeyAnomalyDetection', () => ({ apiKeyAnomalyDetection: () => () => {} }));
vi.mock('@server/middlewares/apiKeyRateLimit', () => ({ apiKeyRateLimit: () => () => {} }));
vi.mock('@server/analytics/analyticsMiddleware', () => ({ analyticsMiddleware: () => () => {} }));
vi.mock('@bike4mind/database', () => ({ connectDB: async () => {} }));
vi.mock('@bike4mind/common', () => ({ ApiKeyScope: {} }));
vi.mock('@bike4mind/server-utils/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://test/%STAGE%', STAGE: 'test' },
  isDevelopment: () => true,
}));

import { baseApi } from './baseApi';

describe('baseApi mounts the default write limit', () => {
  beforeEach(() => {
    h.useCalls.length = 0;
  });

  it.each([true, 'jwtOnly'] as const)('mounts it after the OAuth gate when auth is %s', auth => {
    baseApi({ auth });
    expect(h.useCalls).toContain(h.WRITE_LIMIT_SENTINEL);
    expect(h.useCalls.indexOf(h.WRITE_LIMIT_SENTINEL)).toBeGreaterThan(h.useCalls.indexOf(h.GATE_SENTINEL));
  });

  it('leaves it off a route that opts out', () => {
    baseApi({ auth: true, defaultWriteRateLimit: false });
    expect(h.useCalls).not.toContain(h.WRITE_LIMIT_SENTINEL);
  });

  it('leaves it off an unauthenticated route', () => {
    baseApi({ auth: false });
    expect(h.useCalls).not.toContain(h.WRITE_LIMIT_SENTINEL);
  });
});
