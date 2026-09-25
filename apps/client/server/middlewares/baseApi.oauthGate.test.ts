// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Wiring guard for the OAuth choke point: proves baseApi MOUNTS oauthRouteGate on the normal
 * authenticated (`auth`) chain, with the route's policy and after `auth` has set req.user.
 * oauthRouteGate.test.ts already covers the gate's own enforcement logic; the untested gap was that
 * nothing proved baseApi installs it - deleting the `router.use(oauthRouteGate(...))` line would leave
 * every JWT-authed route open to a relying-party OAuth token with CI green. This records the router's
 * `use()` registrations (next-connect stubbed to a recorder) and keeps oauthRouteGate a sentinel, so
 * we can assert it is registered, gets the resolved `oauthScopes`, sits after `auth`, and is absent on
 * an unauthenticated (`auth:false`) route.
 */

// Sentinels + recorder live in vi.hoisted so the hoisted vi.mock factories below can close over them
// (a plain top-level const is in its TDZ when the hoisted factory runs).
const h = vi.hoisted(() => {
  const useCalls: unknown[] = [];
  const GATE_SENTINEL = () => {};
  // `auth` is the JWT middleware baseApi mounts right before the gate; a distinct sentinel lets us
  // assert relative order (gate must run AFTER auth so req.user exists).
  const AUTH_SENTINEL = () => {};
  const oauthRouteGateMock = vi.fn(() => GATE_SENTINEL);
  return { useCalls, GATE_SENTINEL, AUTH_SENTINEL, oauthRouteGateMock };
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

// oauthRouteGate is a sentinel we can find in the recorded use() list; its logic lives in its own test.
vi.mock('@server/middlewares/oauthRouteGate', () => ({ oauthRouteGate: h.oauthRouteGateMock }));
vi.mock('@server/auth/auth', () => ({ authMiddleware: [], auth: h.AUTH_SENTINEL }));

// Remaining imports are stubbed only to keep baseApi loadable/side-effect-free at import + build time.
vi.mock('@server/services/gears/toolGearObserver', () => ({ registerToolGearObserver: () => {} }));
vi.mock('@server/middlewares/logging', () => ({ logging: () => {} }));
vi.mock('@server/middlewares/errorHandler', () => ({ default: () => {} }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ apiKeyAuth: () => () => {} }));
vi.mock('@server/middlewares/apiKeyAnomalyDetection', () => ({ apiKeyAnomalyDetection: () => () => {} }));
vi.mock('@server/middlewares/apiKeyRateLimit', () => ({ apiKeyRateLimit: () => () => {} }));
vi.mock('@server/analytics/analyticsMiddleware', () => ({ analyticsMiddleware: () => () => {} }));
vi.mock('@bike4mind/database', () => ({ connectDB: async () => {} }));
vi.mock('@bike4mind/common', () => ({ ApiKeyScope: {} }));
vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://test/%STAGE%', STAGE: 'test' },
  isDevelopment: () => true,
}));

import { baseApi } from './baseApi';

describe('baseApi mounts oauthRouteGate on the authenticated chain', () => {
  beforeEach(() => {
    h.useCalls.length = 0;
    vi.clearAllMocks();
  });

  it('registers oauthRouteGate with the route policy, after auth, on an authenticated route', () => {
    baseApi({ auth: true, oauthScopes: ['profile'] });

    expect(h.oauthRouteGateMock).toHaveBeenCalledWith({ oauthScopes: ['profile'] });
    expect(h.useCalls).toContain(h.GATE_SENTINEL);
    // Must run AFTER auth so req.user (and its oauthGrant marker) is set when the gate reads it.
    expect(h.useCalls.indexOf(h.GATE_SENTINEL)).toBeGreaterThan(h.useCalls.indexOf(h.AUTH_SENTINEL));
  });

  it('still mounts the gate (default-deny) when the route sets no oauthScopes', () => {
    baseApi({ auth: true });

    expect(h.oauthRouteGateMock).toHaveBeenCalledWith({ oauthScopes: undefined });
    expect(h.useCalls).toContain(h.GATE_SENTINEL);
  });

  it('does NOT mount the gate on an unauthenticated (auth:false) route', () => {
    baseApi({ auth: false });

    expect(h.oauthRouteGateMock).not.toHaveBeenCalled();
    expect(h.useCalls).not.toContain(h.GATE_SENTINEL);
  });
});
