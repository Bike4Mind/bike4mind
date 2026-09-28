import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const { mockAuthenticate } = vi.hoisted(() => ({ mockAuthenticate: vi.fn() }));

// optionalAuth pulls passport from the raw module and the apiKey shim from apiKeyAuth. The apiKey
// shim passes straight through when no X-API-Key is present, so the Bearer-JWT branch runs.
vi.mock('passport', () => ({ default: { authenticate: mockAuthenticate } }));
vi.mock('@server/middlewares/apiKeyAuth', () => ({
  apiKeyAuth: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));

import { optionalAuth } from './optionalAuth';

const make = (headers: Record<string, string> = {}) => {
  const req = { headers } as unknown as Request;
  const res = { headersSent: false } as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
};

/** Queue the (err, user) the mocked passport.authenticate callback will receive. */
const queueAuthResult = (err: unknown, user: unknown) => {
  mockAuthenticate.mockImplementation((_s: string, _o: unknown, cb: (e: unknown, u: unknown) => void) => {
    return (_req: Request, _res: Response, _next: NextFunction) => cb(err, user);
  });
};

beforeEach(() => mockAuthenticate.mockReset());

describe('optionalAuth', () => {
  it('sets req.user from a valid first-party Bearer token', async () => {
    queueAuthResult(null, { id: 'u1' });
    const { req, res, next } = make({ authorization: 'Bearer good.token' });
    await optionalAuth(req, res, next);
    expect(req.user).toEqual({ id: 'u1' });
    expect(next).toHaveBeenCalledOnce();
  });

  // The bypass this route family had: an openid-only OAuth token was admitted as a full user, so a
  // relying-party app could mint a gate-proof cookie / write annotations as the subject user. It
  // must degrade to anonymous, exactly as oauthRouteGate default-denies it on the normal chain.
  it('degrades a relying-party OAuth access token to anonymous - does NOT set req.user', async () => {
    queueAuthResult(null, { id: 'u1', oauthGrant: { scopes: ['openid'], clientId: 'c1' } });
    const { req, res, next } = make({ authorization: 'Bearer oauth.token' });
    await optionalAuth(req, res, next);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('degrades a pre-MFA (mfaPending) session to anonymous', async () => {
    queueAuthResult(null, { id: 'u1', mfaPending: true });
    const { req, res, next } = make({ authorization: 'Bearer pending.token' });
    await optionalAuth(req, res, next);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('stays anonymous with no Authorization header (never runs the JWT strategy)', async () => {
    const { req, res, next } = make({});
    await optionalAuth(req, res, next);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });
});
