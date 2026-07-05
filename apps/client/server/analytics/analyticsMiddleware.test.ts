// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('@server/middlewares/apiKeyAuth', () => ({
  isApiKeyAuth: vi.fn(() => false),
}));
vi.mock('./emitActiveEvent', async importOriginal => {
  const original = await importOriginal<typeof import('./emitActiveEvent')>();
  return {
    ...original,
    emitActiveEvent: vi.fn().mockResolvedValue(undefined),
    isAnalyticsConfigured: vi.fn(() => true),
  };
});
vi.mock('./pseudonymize', () => ({
  pseudonymizeUserId: vi.fn((id: string) => `pseudo:${id}`),
}));
vi.mock('./resolveUserType', () => ({
  resolveUserType: vi.fn(() => 'free'),
}));

import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { emitActiveEvent, isAnalyticsConfigured } from './emitActiveEvent';
import { analyticsMiddleware, __resetAnalyticsThrottle } from './analyticsMiddleware';

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    user: { id: 'user-1', isSystem: false, level: 'DemoUser', subscribedUntil: null },
    headers: {},
    apiKeyInfo: undefined,
    ...overrides,
  } as unknown as Request;
}

const res = {} as Response;
const next: NextFunction = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  // Throttle map is module-scoped (shared per Lambda instance) - clear it between cases.
  __resetAnalyticsThrottle();
  (isAnalyticsConfigured as ReturnType<typeof vi.fn>).mockReturnValue(true);
  (isApiKeyAuth as ReturnType<typeof vi.fn>).mockReturnValue(false);
});
afterEach(() => vi.restoreAllMocks());

describe('analyticsMiddleware — gating', () => {
  it('calls next() and skips emit when req.user is absent', () => {
    const mw = analyticsMiddleware();
    mw(makeReq({ user: undefined as never }), res, next);
    expect(next).toHaveBeenCalled();
    expect(emitActiveEvent).not.toHaveBeenCalled();
  });

  it('calls next() and skips emit for API-key callers', () => {
    (isApiKeyAuth as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const mw = analyticsMiddleware();
    mw(makeReq(), res, next);
    expect(emitActiveEvent).not.toHaveBeenCalled();
  });

  it('calls next() and skips emit for system users', () => {
    const mw = analyticsMiddleware();
    mw(makeReq({ user: { id: 'sys', isSystem: true, level: 'AdminUser', subscribedUntil: null } as never }), res, next);
    expect(emitActiveEvent).not.toHaveBeenCalled();
  });

  it('calls next() and skips emit when not configured', () => {
    (isAnalyticsConfigured as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const mw = analyticsMiddleware();
    mw(makeReq(), res, next);
    expect(emitActiveEvent).not.toHaveBeenCalled();
  });

  it('emits for an authenticated human user', () => {
    const mw = analyticsMiddleware();
    mw(makeReq(), res, next);
    expect(emitActiveEvent).toHaveBeenCalledOnce();
    expect(next).toHaveBeenCalled();
  });
});

describe('analyticsMiddleware — throttle', () => {
  it('emits only once for the same user on the same day', () => {
    const mw = analyticsMiddleware();
    mw(makeReq(), res, next);
    mw(makeReq(), res, next);
    mw(makeReq(), res, next);
    expect(emitActiveEvent).toHaveBeenCalledOnce();
  });

  it('emits for different users on the same day', () => {
    const mw = analyticsMiddleware();
    mw(
      makeReq({ user: { id: 'user-a', isSystem: false, level: 'DemoUser', subscribedUntil: null } as never }),
      res,
      next
    );
    mw(
      makeReq({ user: { id: 'user-b', isSystem: false, level: 'DemoUser', subscribedUntil: null } as never }),
      res,
      next
    );
    expect(emitActiveEvent).toHaveBeenCalledTimes(2);
  });

  it('shares the throttle across separate middleware instances (one map per Lambda instance)', () => {
    // Regression lock for the per-route-module throttle bug: baseApi() builds a fresh
    // analyticsMiddleware() per route file, so the throttle MUST live at module scope.
    const mwRouteA = analyticsMiddleware();
    const mwRouteB = analyticsMiddleware();
    mwRouteA(makeReq(), res, next); // user-1 emits via route A
    mwRouteB(makeReq(), res, next); // same user, different route — must NOT re-emit
    expect(emitActiveEvent).toHaveBeenCalledOnce();
  });
});

describe('analyticsMiddleware — UTM cookie', () => {
  it('passes utm from the b4m_utm cookie to the emitter', () => {
    const utmPayload = JSON.stringify({ source: 'email', medium: 'newsletter' });
    const mw = analyticsMiddleware();
    mw(makeReq({ headers: { cookie: `b4m_utm=${encodeURIComponent(utmPayload)}` } }), res, next);

    expect(emitActiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ utm: { source: 'email', medium: 'newsletter' } })
    );
  });

  it('passes no utm when cookie is absent', () => {
    const mw = analyticsMiddleware();
    mw(makeReq(), res, next);
    expect(emitActiveEvent).toHaveBeenCalledWith(expect.objectContaining({ utm: undefined }));
  });

  it('passes no utm when the b4m_utm cookie is malformed JSON', () => {
    const mw = analyticsMiddleware();
    mw(makeReq({ headers: { cookie: 'b4m_utm=not-valid-json' } }), res, next);
    expect(emitActiveEvent).toHaveBeenCalledOnce();
    expect(emitActiveEvent).toHaveBeenCalledWith(expect.objectContaining({ utm: undefined }));
  });
});
