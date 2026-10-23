import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';

const { handlers, find, reviewUpdate, release, count, baseOptions } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  find: vi.fn(),
  reviewUpdate: vi.fn(),
  release: vi.fn(),
  count: vi.fn(),
  baseOptions: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (options: unknown) => {
    baseOptions(options);
    const chain = {
      get: (fn: typeof handlers.get) => {
        handlers.get = fn;
        return chain;
      },
      post: (fn: typeof handlers.post) => {
        handlers.post = fn;
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/database', () => ({
  SignupDomainReviewModel: { findOneAndUpdate: reviewUpdate },
  User: { find, countDocuments: count },
}));
vi.mock('@server/auth/emailVerifiedGrants', () => ({ releaseVerifiedPendingFreeCredits: release }));
import '@pages/api/admin/signup-domain-holds';

const makeRequest = (body: unknown, isAdmin = true) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user: { id: 'admin-1', isAdmin }, logger: {} });
  return { req, res };
};
beforeEach(() => {
  reviewUpdate.mockReset().mockResolvedValue({ domain: 'example.net', status: 'released' });
  find.mockReset().mockReturnValue({
    sort: vi.fn().mockReturnValue({
      limit: vi.fn().mockResolvedValue([{ _id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: 25 }]),
    }),
  });
  count.mockReset().mockResolvedValue(0);
  release.mockReset().mockResolvedValue({ creditsGranted: 25 });
});
describe('signup domain hold decisions', () => {
  it('is session-only and rejects non-admin decisions before reading or writing', async () => {
    expect(baseOptions).toHaveBeenCalledWith({ auth: 'jwtOnly' });
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' }, false);
    await expect(handlers.post(req, res)).rejects.toThrow(/admin access required/i);
    expect(reviewUpdate).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
  it('releases only verified pending users from the reviewed domain and reports remaining work', async () => {
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' });
    await handlers.post(req, res);
    expect(reviewUpdate).toHaveBeenCalledWith(
      { domain: 'example.net', status: { $in: ['held_pending_review', 'blocked', 'released'] } },
      { $set: { status: 'released', reviewedBy: 'admin-1', reviewedAt: expect.any(Date) } },
      { new: true }
    );
    const filter = find.mock.calls[0][0];
    expect(filter).toMatchObject({ emailVerified: true, tags: PENDING_FREE_CREDITS_TAG });
    const domainMatch = new RegExp(filter.email.$regex, filter.email.$options);
    expect(domainMatch.test('a@sub.example.net')).toBe(true);
    expect(domainMatch.test('a@otherexample.net')).toBe(false);
    expect(release).toHaveBeenCalledWith(
      { id: 'user-1', tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: 25 },
      'Signup domain hold released by admin',
      expect.anything()
    );
    expect(res._getJSONData()).toEqual({ status: 'released', creditsReleased: 25, remaining: 0, nextCursor: null });
  });
  it('continues after a failed full batch rather than starving later users', async () => {
    const cursor = '000000000000000000000064';
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      _id: (index + 1).toString(16).padStart(24, '0'),
      tags: [PENDING_FREE_CREDITS_TAG],
    }));
    find.mockReturnValue({ sort: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue(candidates) }) });
    release.mockResolvedValue({ creditsGranted: 0 });
    count.mockResolvedValue(101);
    const first = makeRequest({ domain: 'example.net', action: 'release' });
    await handlers.post(first.req, first.res);
    expect(first.res._getJSONData()).toMatchObject({ remaining: 101, nextCursor: cursor });
    find.mockClear();
    find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([{ _id: '000000000000000000000065', tags: [PENDING_FREE_CREDITS_TAG] }]),
      }),
    });
    release.mockResolvedValue({ creditsGranted: 25 });
    const next = makeRequest({ domain: 'example.net', action: 'release', afterUserId: cursor });
    await handlers.post(next.req, next.res);
    expect(find.mock.calls[0][0]).toMatchObject({ _id: { $gt: cursor } });
    expect(next.res._getJSONData()).toMatchObject({ creditsReleased: 25, nextCursor: null });
  });
  it('confirmation grants no credits', async () => {
    const { req, res } = makeRequest({ domain: 'example.net', action: 'confirm' });
    await handlers.post(req, res);
    expect(release).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
  });
  it('rejects invalid decisions and does not grant for a missing hold', async () => {
    const invalid = makeRequest({ domain: 'example.net', action: 'delete' });
    await expect(handlers.post(invalid.req, invalid.res)).rejects.toThrow(/Expected a domain/);
    expect(reviewUpdate).not.toHaveBeenCalled();
    reviewUpdate.mockResolvedValue(null);
    const missing = makeRequest({ domain: 'example.net', action: 'release' });
    await expect(handlers.post(missing.req, missing.res)).rejects.toThrow(/Hold not found/);
    expect(release).not.toHaveBeenCalled();
  });
});
