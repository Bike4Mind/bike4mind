// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Wiring guard for the IP-block choke point: an admin's `all` block refuses every authenticated write
 * because baseApi mounts checkBlockedIP on the authenticated chain (checkout and every AI route rely on
 * it rather than a per-route list). checkBlockedIP.test.ts covers the gate's own logic; this proves
 * baseApi installs it after `auth` (so admins can be exempted) and leaves `auth:false` routes to opt in.
 */

const h = vi.hoisted(() => {
  const useCalls: unknown[] = [];
  const GATE_SENTINEL = () => {};
  const AUTH_SENTINEL = () => {};
  const checkBlockedIPMock = vi.fn(() => GATE_SENTINEL);
  return { useCalls, GATE_SENTINEL, AUTH_SENTINEL, checkBlockedIPMock };
});

vi.mock('next-connect', () => ({
  default: () => {
    const router: any = {
      use: (...mw: unknown[]) => {
        h.useCalls.push(...mw);
        return router;
      },
    };
    return router;
  },
}));

vi.mock('@server/middlewares/oauthRouteGate', () => ({ oauthRouteGate: () => () => {} }));
vi.mock('@server/middlewares/checkBlockedIP', () => ({ checkBlockedIP: h.checkBlockedIPMock }));
vi.mock('@server/auth/auth', () => ({ authMiddleware: [], auth: h.AUTH_SENTINEL }));

// Remaining imports are stubbed only to keep baseApi loadable/side-effect-free at import + build time.
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

describe('baseApi mounts the IP-block gate on the authenticated chain', () => {
  beforeEach(() => {
    h.useCalls.length = 0;
    vi.clearAllMocks();
  });

  it.each([true, 'jwtOnly'] as const)('mounts the app-surface write gate after auth (auth: %s)', auth => {
    baseApi({ auth });
    expect(h.checkBlockedIPMock).toHaveBeenCalledWith({ surface: 'app', writesOnly: true, exemptAdmins: true });
    expect(h.useCalls.indexOf(h.GATE_SENTINEL)).toBeGreaterThan(h.useCalls.indexOf(h.AUTH_SENTINEL));
  });

  it('leaves an unauthenticated route to opt in itself', () => {
    baseApi({ auth: false });
    expect(h.useCalls).not.toContain(h.GATE_SENTINEL);
  });
});
