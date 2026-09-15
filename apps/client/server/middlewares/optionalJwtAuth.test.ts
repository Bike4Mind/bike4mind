import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Request, Response, NextFunction } from 'express';

const { mockAuthenticate, mockAbility } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockAbility: vi.fn(() => ({ can: () => true })),
}));

// passport.authenticate(strategy, opts, cb) returns the actual middleware (req,res,next).
// Our mock returns a middleware that invokes cb with whatever (err,user) the test queued.
vi.mock('@server/auth/auth', () => ({
  default: { authenticate: mockAuthenticate },
}));
vi.mock('@server/auth/ability', () => ({ default: mockAbility }));

import { optionalJwtAuth } from './optionalJwtAuth';

const make = (headers: Record<string, string> = {}, user?: unknown) => {
  const req = { headers, user } as unknown as Request;
  const res = {} as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
};

/** Queue the (err, user) the mocked passport.authenticate callback will receive. */
const queueAuthResult = (err: unknown, user: unknown) => {
  mockAuthenticate.mockImplementation((_strategy: string, _opts: unknown, cb: (e: unknown, u: unknown) => void) => {
    return (_req: Request, _res: Response, _next: NextFunction) => cb(err, user);
  });
};

beforeEach(() => {
  mockAuthenticate.mockReset();
  mockAbility.mockClear();
});

describe('optionalJwtAuth', () => {
  it('passes through (no req.user) when there is no Authorization header', () => {
    const { req, res, next } = make({});
    optionalJwtAuth()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBeUndefined();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('leaves an ApiKey authorization untouched for the apiKey shim', () => {
    const { req, res, next } = make({ authorization: 'ApiKey abc123' });
    optionalJwtAuth()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(req.user).toBeUndefined();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('short-circuits to next() when req.user is already set', () => {
    const { req, res, next } = make({ authorization: 'Bearer x.y.z' }, { id: 'pre' });
    optionalJwtAuth()(req, res, next);
    expect(next).toHaveBeenCalledOnce();
    expect(mockAuthenticate).not.toHaveBeenCalled();
  });

  it('sets req.user from a valid Bearer token', () => {
    queueAuthResult(null, { id: 'u1' });
    const { req, res, next } = make({ authorization: 'Bearer good.token' });
    optionalJwtAuth()(req, res, next);
    expect(req.user).toEqual({ id: 'u1' });
    expect(req.ability).toBeDefined();
    expect(mockAbility).toHaveBeenCalledWith({ id: 'u1' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('accepts a case-insensitive Bearer scheme (RFC 6750)', () => {
    queueAuthResult(null, { id: 'u1' });
    const { req, res, next } = make({ authorization: 'bearer good.token' });
    optionalJwtAuth()(req, res, next);
    expect(mockAuthenticate).toHaveBeenCalled(); // lowercase scheme still takes the JWT path
    expect(req.user).toEqual({ id: 'u1' });
  });

  it('degrades a pre-MFA (mfaPending) session to anonymous — does NOT set req.user', () => {
    // The JWT strategy returns the user as a success but stamps mfaPending; this auth:false
    // route bypasses the normal mfaPending block, so the shim must enforce it.
    queueAuthResult(null, { id: 'u1', mfaPending: true });
    const { req, res, next } = make({ authorization: 'Bearer pending.token' });
    optionalJwtAuth()(req, res, next);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through anonymously (no 401) on an invalid/expired Bearer token', () => {
    queueAuthResult(null, false);
    const { req, res, next } = make({ authorization: 'Bearer bad.token' });
    optionalJwtAuth()(req, res, next);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through anonymously but logs a warning when the strategy errors', () => {
    queueAuthResult(new Error('boom'), null);
    const warn = vi.fn();
    const { req, res, next } = make({ authorization: 'Bearer err.token' });
    (req as unknown as { logger: { warn: typeof warn } }).logger = { warn };
    optionalJwtAuth()(req, res, next);
    expect(req.user).toBeUndefined();
    expect(next).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce(); // a strategy ERROR is observable (possible misconfig)
  });

  it('stays silent (no warn) for a bare invalid token', () => {
    queueAuthResult(null, false);
    const warn = vi.fn();
    const { req, res, next } = make({ authorization: 'Bearer bad.token' });
    (req as unknown as { logger: { warn: typeof warn } }).logger = { warn };
    optionalJwtAuth()(req, res, next);
    expect(warn).not.toHaveBeenCalled(); // absent/invalid token is the normal anonymous path
  });
});
