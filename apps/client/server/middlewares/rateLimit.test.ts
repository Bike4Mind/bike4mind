import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TooManyRequestsError } from '@bike4mind/utils';
import type { Request, Response } from 'express';

const { tryIncrementMock } = vi.hoisted(() => ({
  tryIncrementMock:
    vi.fn<
      (key: string, limit: number, ttlMs: number) => Promise<{ success: boolean; count: number; expiresAt: Date }>
    >(),
}));

vi.mock('@bike4mind/database', () => ({
  cacheRepository: { tryIncrementWithinLimitFixedWindow: tryIncrementMock },
}));
vi.mock('@server/utils/ip', () => ({ getClientIp: () => '203.0.113.7' }));

import { rateLimit } from './rateLimit';

const makeReq = (overrides: Partial<Request> = {}): Request =>
  ({ url: '/api/chat', user: { id: 'user-1' }, ...overrides }) as unknown as Request;

const makeRes = () => {
  const res = { setHeader: vi.fn() } as unknown as Response;
  return res;
};

describe('rateLimit middleware', () => {
  beforeEach(() => {
    tryIncrementMock.mockReset();
    tryIncrementMock.mockResolvedValue({ success: true, count: 1, expiresAt: new Date(Date.now() + 60_000) });
  });

  it('keys the counter on the user id (IP-independent) using a static limit', async () => {
    const next = vi.fn();
    await rateLimit({ limit: 10, windowMs: 60_000 })(makeReq(), makeRes(), next);

    expect(tryIncrementMock).toHaveBeenCalledWith('rate-limit:user-1:/api/chat', 10, 60_000);
    expect(next).toHaveBeenCalledWith(); // no error → allowed
  });

  it('counts against a caller-supplied subject instead of the user, for a per-resource cap', async () => {
    // A per-user cap on an expensive per-resource action bounds one caller, not the resource: N
    // principals with rights to it each get the full allowance. `subject` is what lets a route bound
    // the resource itself.
    const next = vi.fn();
    await rateLimit({ limit: 6, windowMs: 60_000, bucket: 'b', subject: () => 'lake:lake-9' })(
      makeReq(),
      makeRes(),
      next
    );

    expect(tryIncrementMock).toHaveBeenCalledWith('rate-limit:lake:lake-9:b', 6, 60_000);
    expect(next).toHaveBeenCalledWith();
  });

  it('falls back to the default subject when the resolver returns undefined', async () => {
    // Falling back can only make the limit STRICTER (the caller's own bucket); it must never leave
    // the request uncounted.
    const next = vi.fn();
    await rateLimit({ limit: 6, windowMs: 60_000, bucket: 'b', subject: () => undefined })(makeReq(), makeRes(), next);

    expect(tryIncrementMock).toHaveBeenCalledWith('rate-limit:user-1:b', 6, 60_000);
  });

  it('resolves the limit per request when given a resolver function', async () => {
    const next = vi.fn();
    const limitResolver = vi.fn(async () => 42);
    await rateLimit({ limit: limitResolver, windowMs: 60_000 })(makeReq(), makeRes(), next);

    expect(limitResolver).toHaveBeenCalledTimes(1);
    expect(tryIncrementMock).toHaveBeenCalledWith('rate-limit:user-1:/api/chat', 42, 60_000);
    expect(next).toHaveBeenCalledWith();
  });

  it('bypasses enforcement (no counter touched) when the resolver returns Infinity', async () => {
    const next = vi.fn();
    await rateLimit({ limit: () => Infinity, windowMs: 60_000 })(makeReq(), makeRes(), next);

    expect(tryIncrementMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('bypasses enforcement when the resolved limit is non-positive', async () => {
    const next = vi.fn();
    await rateLimit({ limit: () => 0, windowMs: 60_000 })(makeReq(), makeRes(), next);

    expect(tryIncrementMock).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith();
  });

  it('rejects with TooManyRequestsError and sets Retry-After when the limit is exceeded', async () => {
    const expiresAt = new Date(Date.now() + 30_000);
    tryIncrementMock.mockResolvedValue({ success: false, count: 11, expiresAt });
    const res = makeRes();
    const next = vi.fn();

    await rateLimit({ limit: 10, windowMs: 60_000 })(makeReq(), res, next);

    expect(res.setHeader).toHaveBeenCalledWith('Retry-After', expect.any(Number));
    expect(next).toHaveBeenCalledTimes(1);
    expect(next.mock.calls[0][0]).toBeInstanceOf(TooManyRequestsError);
  });

  it('falls back to the client IP when the request is unauthenticated', async () => {
    const next = vi.fn();
    await rateLimit({ limit: 10, windowMs: 60_000 })(makeReq({ user: undefined }), makeRes(), next);

    expect(tryIncrementMock).toHaveBeenCalledWith('rate-limit:203.0.113.7:/api/chat', 10, 60_000);
  });
});
