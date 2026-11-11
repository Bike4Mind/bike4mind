// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Wiring guard: baseApi mounts the last-active stamp on authenticated routes and threads the
 * route's `recordsActivity` into API-key auth, so a route the app calls on its own (telemetry,
 * socket tickets) neither stamps the user nor counts as a use of the key. The stamp's own logic is
 * in userActivity.test.ts. Same recorder harness as baseApi.defaultWriteRateLimit.test.ts.
 */

const h = vi.hoisted(() => {
  const useCalls: unknown[] = [];
  const GATE_SENTINEL = () => {};
  const IP_BLOCK_SENTINEL = () => {};
  const WRITE_LIMIT_SENTINEL = () => {};
  const ACTIVITY_SENTINEL = () => {};
  const apiKeyAuthCalls: unknown[][] = [];
  return { useCalls, GATE_SENTINEL, IP_BLOCK_SENTINEL, WRITE_LIMIT_SENTINEL, ACTIVITY_SENTINEL, apiKeyAuthCalls };
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
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: () => h.IP_BLOCK_SENTINEL }));
vi.mock('@server/auth/auth', () => ({ authMiddleware: [], auth: () => {} }));

// Stubbed only to keep baseApi loadable and side-effect-free.
vi.mock('@bike4mind/server-utils/services/gears/toolGearObserver', () => ({ registerToolGearObserver: () => {} }));
vi.mock('@bike4mind/server-utils/lib/settings/registerContributedSettings', () => ({}));
vi.mock('@server/middlewares/logging', () => ({ logging: () => {} }));
vi.mock('@server/middlewares/errorHandler', () => ({ default: () => {} }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({
  apiKeyAuth: (...args: unknown[]) => {
    h.apiKeyAuthCalls.push(args);
    return () => {};
  },
}));
vi.mock('@server/middlewares/userActivity', () => ({ userActivityMiddleware: () => h.ACTIVITY_SENTINEL }));
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

describe('baseApi records user activity', () => {
  beforeEach(() => {
    h.useCalls.length = 0;
    h.apiKeyAuthCalls.length = 0;
  });

  it.each([true, 'jwtOnly'] as const)(
    'mounts the stamp after the IP-block and write-limit gates when auth is %s',
    auth => {
      baseApi({ auth });
      const stamp = h.useCalls.indexOf(h.ACTIVITY_SENTINEL);
      expect(stamp).toBeGreaterThan(h.useCalls.indexOf(h.IP_BLOCK_SENTINEL));
      expect(stamp).toBeGreaterThan(h.useCalls.indexOf(h.WRITE_LIMIT_SENTINEL));
      expect(h.useCalls.indexOf(h.WRITE_LIMIT_SENTINEL)).toBeGreaterThan(-1);
    }
  );

  it('counts an API-key call as a use of the key by default', () => {
    baseApi({ auth: true });
    expect(h.apiKeyAuthCalls).toEqual([[undefined, undefined, { recordUse: true }]]);
  });

  it('neither stamps the user nor counts key use on a route that opts out', () => {
    baseApi({ auth: true, recordsActivity: false });
    expect(h.useCalls).not.toContain(h.ACTIVITY_SENTINEL);
    expect(h.apiKeyAuthCalls).toEqual([[undefined, undefined, { recordUse: false }]]);
  });

  it('leaves it off an unauthenticated route', () => {
    baseApi({ auth: false });
    expect(h.useCalls).not.toContain(h.ACTIVITY_SENTINEL);
  });
});
