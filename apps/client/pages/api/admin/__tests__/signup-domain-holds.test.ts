import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope, PENDING_FREE_CREDITS_TAG } from '@bike4mind/common';

const { handlers, find, reviewUpdate, release, eligible, count, baseOptions } = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  find: vi.fn(),
  reviewUpdate: vi.fn(),
  release: vi.fn(),
  eligible: vi.fn(),
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
vi.mock('@bike4mind/database', () => {
  const reviewQuery = {
    sort: () => reviewQuery,
    skip: () => reviewQuery,
    limit: () => reviewQuery,
    lean: async () => [],
  };
  return {
    SignupDomainReviewModel: { findOneAndUpdate: reviewUpdate, find: () => reviewQuery, countDocuments: async () => 0 },
    DomainIntelligenceModel: { estimatedDocumentCount: async () => 12 },
    disposableDomainRepository: {
      getDisposableSourceStatus: async () => [
        { source: 'curated', count: 3, lastSuccessAt: new Date('2026-01-02') },
        { source: 'aggregate', count: 0, lastError: 'HTTP 503', lastErrorAt: new Date('2026-01-02') },
      ],
    },
    User: { find, countDocuments: count },
  };
});
vi.mock('@server/auth/emailVerifiedGrants', () => ({
  isEligibleForFreeCredits: eligible,
  releaseVerifiedPendingFreeCredits: release,
}));
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
      limit: vi
        .fn()
        .mockResolvedValue([
          { _id: 'user-1', email: 'a@sub.example.net', tags: [PENDING_FREE_CREDITS_TAG], pendingCreditGrant: 25 },
        ]),
    }),
  });
  count.mockReset().mockResolvedValue(0);
  release.mockReset().mockResolvedValue({ creditsGranted: 25, tags: [] });
  eligible.mockReset().mockResolvedValue(true);
});
describe('signup domain hold listing', () => {
  it('reports per-source list freshness and the lookup cache size', async () => {
    const { req, res } = createMocks({ method: 'GET', query: {} });
    Object.assign(req, { user: { id: 'admin-1', isAdmin: true } });
    await handlers.get(req, res);
    expect(res._getJSONData()).toMatchObject({
      total: 0,
      intelCacheSize: 12,
      sources: [
        { source: 'curated', count: 3 },
        { source: 'aggregate', count: 0, lastError: 'HTTP 503' },
      ],
    });
  });
});
describe('signup domain hold decisions', () => {
  it('is session-only and rejects non-admin decisions before reading or writing', async () => {
    expect(baseOptions).toHaveBeenCalledWith({ auth: 'jwtOnly', requiredScopes: [ApiKeyScope.ADMIN] });
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
      expect.anything(),
      undefined,
      { bypassBudget: true }
    );
    expect(res._getJSONData()).toEqual({ status: 'released', creditsReleased: 25, remaining: 0, nextCursor: null });
    // A single page saw every candidate, so the unindexed regex is not scanned a second time.
    expect(count).not.toHaveBeenCalled();
  });
  it('keeps users on a blocked or disposable domain pending when the hold is released', async () => {
    eligible.mockResolvedValue(false);
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' });
    await handlers.post(req, res);
    expect(eligible).toHaveBeenCalledWith('a@sub.example.net', expect.anything());
    expect(release).not.toHaveBeenCalled();
    expect(res._getJSONData()).toMatchObject({ creditsReleased: 0, remaining: 1, nextCursor: null });
  });
  it('matches trailing-dot addresses only within the reviewed domain', async () => {
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' });
    await handlers.post(req, res);
    const filter = find.mock.calls[0][0];
    const domainMatch = new RegExp(filter.email.$regex, filter.email.$options);
    expect(domainMatch.test('person@example.net.')).toBe(true);
    expect(domainMatch.test('person@example.net')).toBe(true);
    expect(domainMatch.test('person@example.network')).toBe(false);
  });
  it('counts a failed release as still pending', async () => {
    release.mockResolvedValue({ creditsGranted: 0, tags: null });
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' });
    await handlers.post(req, res);
    expect(res._getJSONData()).toMatchObject({ creditsReleased: 0, remaining: 1 });
  });
  it('continues after a failed full batch rather than starving later users', async () => {
    const cursor = '000000000000000000000064';
    const candidates = Array.from({ length: 100 }, (_, index) => ({
      _id: (index + 1).toString(16).padStart(24, '0'),
      email: `user${index}@example.net`,
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
        limit: vi
          .fn()
          .mockResolvedValue([
            { _id: '000000000000000000000065', email: 'late@example.net', tags: [PENDING_FREE_CREDITS_TAG] },
          ]),
      }),
    });
    release.mockResolvedValue({ creditsGranted: 25, tags: [] });
    count.mockResolvedValue(0);
    const next = makeRequest({ domain: 'example.net', action: 'release', afterUserId: cursor });
    await handlers.post(next.req, next.res);
    expect(find.mock.calls[0][0]).toMatchObject({ _id: { $gt: cursor } });
    expect(next.res._getJSONData()).toMatchObject({ creditsReleased: 25, remaining: 0, nextCursor: null });
    expect(count).toHaveBeenCalledTimes(2);
  });
  it('confirmation grants no credits', async () => {
    const { req, res } = makeRequest({ domain: 'example.net', action: 'confirm' });
    await handlers.post(req, res);
    expect(reviewUpdate.mock.calls[0][1]).toMatchObject({ $set: { status: 'blocked' } });
    expect(res._getJSONData()).toMatchObject({ status: 'blocked' });
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
