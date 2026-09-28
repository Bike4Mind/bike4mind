// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * Pins `req.receivedAt` as the request's ARRIVAL: stamped by the first middleware baseApi mounts,
 * ahead of connectDB and the auth/api-key chain. The crypto-shred fence refuses a write only when a
 * purge lands at or after `startedAt`, so a stamp taken after any of those awaits would let a purge
 * that landed in the gap lift its own tombstone. next-connect is stubbed to a recorder and the
 * recorded chain is driven in order, with connectDB advancing the clock so a late stamp is visible.
 */

const ARRIVAL = new Date('2026-01-01T00:00:00.000Z');
const CONNECT_COST_MS = 5_000;

const h = vi.hoisted(() => {
  type Middleware = (req: unknown, res: unknown, next: () => unknown) => unknown;
  const useCalls: Middleware[] = [];
  // What each downstream middleware saw on `req.receivedAt` when it ran, by name.
  const seenAt: Record<string, unknown> = {};
  const observe =
    (name: string): Middleware =>
    (req, _res, next) => {
      seenAt[name] = (req as { receivedAt?: unknown }).receivedAt;
      return next();
    };
  return { useCalls, seenAt, observe };
});

vi.mock('next-connect', () => ({
  default: () => {
    const router = {
      use: (...middlewares: typeof h.useCalls) => {
        h.useCalls.push(...middlewares);
        return router;
      },
    };
    return router;
  },
}));

vi.mock('@bike4mind/database', () => ({
  connectDB: async () => {
    vi.setSystemTime(Date.now() + CONNECT_COST_MS);
  },
}));
vi.mock('@server/middlewares/logging', () => ({ logging: h.observe('logging') }));
vi.mock('@server/auth/auth', () => ({ authMiddleware: [h.observe('authMiddleware')], auth: h.observe('auth') }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({ apiKeyAuth: () => h.observe('apiKeyAuth') }));
vi.mock('@server/middlewares/apiKeyAnomalyDetection', () => ({ apiKeyAnomalyDetection: () => h.observe('anomaly') }));
vi.mock('@server/middlewares/apiKeyRateLimit', () => ({ apiKeyRateLimit: () => h.observe('rateLimit') }));
vi.mock('@server/middlewares/oauthRouteGate', () => ({ oauthRouteGate: () => h.observe('oauthRouteGate') }));
vi.mock('@server/analytics/analyticsMiddleware', () => ({ analyticsMiddleware: () => h.observe('analytics') }));
vi.mock('@server/services/gears/toolGearObserver', () => ({ registerToolGearObserver: () => {} }));
vi.mock('@server/middlewares/errorHandler', () => ({ default: () => {} }));
vi.mock('@bike4mind/common', () => ({ ApiKeyScope: {} }));
vi.mock('@server/utils/config', () => ({
  Config: { MONGODB_URI: 'mongodb://test/%STAGE%', STAGE: 'test' },
  isDevelopment: () => true,
}));

import { baseApi } from './baseApi';

const runRecordedChain = async (req: Record<string, unknown>) => {
  for (const middleware of h.useCalls) {
    let advanced = false;
    await middleware(req, {}, () => {
      advanced = true;
    });
    if (!advanced) throw new Error('a baseApi middleware did not call next()');
  }
};

describe('baseApi stamps req.receivedAt on arrival', () => {
  beforeEach(() => {
    h.useCalls.length = 0;
    for (const key of Object.keys(h.seenAt)) delete h.seenAt[key];
    vi.useFakeTimers();
    vi.setSystemTime(ARRIVAL);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('takes the stamp before connectDB awaits, not after', async () => {
    baseApi({ auth: true });
    const req: Record<string, unknown> = { headers: {} };

    await runRecordedChain(req);

    // The clock moved during connectDB; the stamp must predate that, i.e. equal the arrival.
    expect(Date.now()).toBe(ARRIVAL.getTime() + CONNECT_COST_MS);
    expect(req.receivedAt).toEqual(ARRIVAL);
  });

  it('is already set when every other middleware runs, including logging and the auth chain', async () => {
    baseApi({ auth: true });
    const req: Record<string, unknown> = { headers: {} };

    await runRecordedChain(req);

    const observed = [
      'logging',
      'authMiddleware',
      'apiKeyAuth',
      'anomaly',
      'rateLimit',
      'auth',
      'oauthRouteGate',
      'analytics',
    ];
    for (const name of observed) {
      expect(h.seenAt[name], name).toBe(req.receivedAt);
    }
  });

  it('is stamped on an unauthenticated route too', async () => {
    baseApi({ auth: false });
    const req: Record<string, unknown> = { headers: {} };

    await runRecordedChain(req);

    expect(req.receivedAt).toEqual(ARRIVAL);
  });
});
