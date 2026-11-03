// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

vi.mock('@server/middlewares/apiKeyAuth', () => ({
  isApiKeyAuth: vi.fn(() => false),
}));
vi.mock('@bike4mind/server-utils/analytics/emitActiveEvent', async importOriginal => {
  const original = await importOriginal<typeof import('@bike4mind/server-utils/analytics/emitActiveEvent')>();
  return {
    ...original,
    emitActiveEvent: vi.fn().mockResolvedValue(undefined),
    isAnalyticsConfigured: vi.fn(() => true),
  };
});
vi.mock('@bike4mind/server-utils/analytics/pseudonymize', () => ({
  pseudonymizeUserId: vi.fn((id: string) => `pseudo:${id}`),
}));
vi.mock('./resolveUserType', () => ({
  resolveUserType: vi.fn(() => 'free'),
}));

import { OVERWATCH_UNKNOWN_SESSION_ID } from '@bike4mind/common';
import { isApiKeyAuth } from '@server/middlewares/apiKeyAuth';
import { emitActiveEvent, isAnalyticsConfigured } from '@bike4mind/server-utils/analytics/emitActiveEvent';
import { analyticsMiddleware, __resetAnalyticsThrottle } from './analyticsMiddleware';
import { VISIT_COOKIE, mintVisitId } from './visitSession';

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

describe('analyticsMiddleware - synthetic lane', () => {
  it("marks a synthetic user's active event with the synthetic lane", () => {
    const mw = analyticsMiddleware();
    mw(
      makeReq({
        user: {
          id: 'persona-1',
          isSystem: false,
          level: 'DemoUser',
          subscribedUntil: null,
          isSynthetic: true,
        } as never,
      }),
      res,
      next
    );
    expect(emitActiveEvent).toHaveBeenCalledWith(expect.objectContaining({ isSynthetic: true }));
    expect(next).toHaveBeenCalled();
  });

  it('does not mark a user without the flag', () => {
    const mw = analyticsMiddleware();
    mw(makeReq(), res, next);
    expect(emitActiveEvent).toHaveBeenCalledWith(
      expect.objectContaining({ isSynthetic: false, isInternal: false, isAdmin: false })
    );
  });

  it("passes an internal account's and an admin's flags to the emitter, which marks them", () => {
    const mw = analyticsMiddleware();
    const user = (id: string, flags: object) =>
      ({ id, isSystem: false, level: 'DemoUser', subscribedUntil: null, ...flags }) as never;
    mw(makeReq({ user: user('staff-1', { isInternal: true }) }), res, next);
    mw(makeReq({ user: user('admin-1', { isAdmin: true }) }), res, next);
    expect(emitActiveEvent).toHaveBeenNthCalledWith(1, expect.objectContaining({ isInternal: true, isAdmin: false }));
    expect(emitActiveEvent).toHaveBeenNthCalledWith(2, expect.objectContaining({ isInternal: false, isAdmin: true }));
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

describe('analyticsMiddleware - a marked user is reported once per visit', () => {
  const marked = (flags: object) =>
    makeReq({ user: { id: 'staff-1', isSystem: false, level: 'DemoUser', subscribedUntil: null, ...flags } as never });
  const inVisit = (req: Request, visitId: string) =>
    ({ ...req, headers: { cookie: `${VISIT_COOKIE}=${visitId}` } }) as Request;

  it.each([
    ['an internal account', { isInternal: true }],
    ['an admin', { isAdmin: true }],
    ['a synthetic user', { isSynthetic: true }],
  ])('emits again for %s in a new visit, so each of their visits carries a marked event', (_name, flags) => {
    const [first, second] = [mintVisitId(), mintVisitId()];
    const mw = analyticsMiddleware();
    mw(inVisit(marked(flags), first), res, next);
    mw(inVisit(marked(flags), first), res, next);
    mw(inVisit(marked(flags), second), res, next);
    mw(marked(flags), res, next);

    const sessions = (emitActiveEvent as unknown as { mock: { calls: Array<[{ sessionId: string }]> } }).mock.calls.map(
      ([event]) => event.sessionId
    );
    expect(sessions).toEqual([first, second, OVERWATCH_UNKNOWN_SESSION_ID]);
    expect(next).toHaveBeenCalledTimes(4);
  });

  it("keeps a customer's emit to once a day, whatever the visit", () => {
    const mw = analyticsMiddleware();
    mw(inVisit(makeReq(), mintVisitId()), res, next);
    mw(inVisit(makeReq(), mintVisitId()), res, next);
    mw(makeReq(), res, next);
    expect(emitActiveEvent).toHaveBeenCalledOnce();
  });
});

describe('analyticsMiddleware session identifier', () => {
  it('reports the visit the request belongs to', () => {
    const visitId = mintVisitId();
    const mw = analyticsMiddleware();
    mw(makeReq({ headers: { cookie: `${VISIT_COOKIE}=${visitId}` } }), res, next);

    // The same value the visit beacon emitted for this visit, so the two events are one
    // session downstream instead of two.
    expect(emitActiveEvent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: visitId }));
  });

  // This is the fix for a first stage that counted authenticated user-days under the name
  // "sessions": the identifier used to be sha256(pseudoUserId : UTC-date), stable for a
  // whole day by construction. A per-user-per-day value must never come back here.
  it('does not fall back to anything derived from the user or the day', () => {
    const mw = analyticsMiddleware();
    mw(makeReq(), res, next);

    const emitted = (emitActiveEvent as unknown as { mock: { calls: Array<[{ sessionId: string }]> } }).mock
      .calls[0][0];
    expect(emitted.sessionId).toBe(OVERWATCH_UNKNOWN_SESSION_ID);
  });

  it('treats a visit id it never minted as no visit at all', () => {
    const mw = analyticsMiddleware();
    mw(makeReq({ headers: { cookie: `${VISIT_COOKIE}=pick-your-own-session-id` } }), res, next);

    expect(emitActiveEvent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: OVERWATCH_UNKNOWN_SESSION_ID }));
  });
});
