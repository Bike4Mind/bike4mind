import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import {
  ApiKeyScope,
  ForbiddenError,
  MODERATION_PAGE_READ,
  PENDING_FREE_CREDITS_TAG,
  meetsAdminPermissionRequirement,
  missingAdminPermissionMessage,
  type AdminPermissionRequirement,
} from '@bike4mind/common';

const {
  handlers,
  find,
  reviewUpdate,
  reviewFind,
  release,
  eligible,
  count,
  baseOptions,
  recordAudit,
  listed,
  countByStatus,
  settings,
} = vi.hoisted(() => ({
  handlers: {} as Record<string, (req: unknown, res: unknown) => Promise<void>>,
  listed: vi.fn(async (_filter: unknown, _page: number, _limit: number): Promise<unknown[]> => []),
  countByStatus: vi.fn(async (_filter: unknown) => ({ pending: 0, blocked: 0, released: 0, all: 0 })),
  settings: vi.fn(async (): Promise<Record<string, unknown>> => ({})),
  find: vi.fn(),
  reviewUpdate: vi.fn(),
  reviewFind: vi.fn(),
  release: vi.fn(),
  eligible: vi.fn(),
  count: vi.fn(),
  baseOptions: vi.fn(),
  recordAudit: vi.fn(),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));
vi.mock('@server/middlewares/adminApi', () => ({
  requireAdminPermission: (
    req: { user?: Parameters<typeof meetsAdminPermissionRequirement>[0] },
    requirement: AdminPermissionRequirement
  ) => {
    if (!meetsAdminPermissionRequirement(req.user, requirement)) {
      throw new ForbiddenError(missingAdminPermissionMessage(requirement));
    }
  },
  adminApi: (options: { adminPermissions: Partial<Record<string, AdminPermissionRequirement>> }) => {
    baseOptions(options);
    const gated =
      (method: string, fn: (req: unknown, res: unknown) => Promise<void>) => async (req: unknown, res: unknown) => {
        const requirement = options.adminPermissions[method];
        const { user } = req as { user?: Parameters<typeof meetsAdminPermissionRequirement>[0] };
        if (requirement && !meetsAdminPermissionRequirement(user, requirement)) {
          throw new ForbiddenError(missingAdminPermissionMessage(requirement));
        }
        return fn(req, res);
      };
    const chain = {
      get: (fn: typeof handlers.get) => {
        handlers.get = gated('GET', fn);
        return chain;
      },
      post: (fn: typeof handlers.post) => {
        handlers.post = gated('POST', fn);
        return chain;
      },
    };
    return chain;
  },
}));
vi.mock('@bike4mind/utils', () => ({
  getSettingsMap: settings,
  getSettingsValue: (key: string, values: Record<string, unknown>, fallback: unknown) => values[key] ?? fallback,
}));
vi.mock('@bike4mind/database', () => {
  return {
    adminSettingsRepository: {},
    signupDomainHoldListRepository: { list: listed, countByStatus },
    SignupDomainReviewModel: { findOneAndUpdate: reviewUpdate, findOne: reviewFind },
    DomainIntelligenceModel: { estimatedDocumentCount: async () => 12 },
    disposableDomainRepository: {
      getDisposableSourceStatus: async () => [
        { source: 'curated', count: 3, lastSuccessAt: new Date('2026-01-02') },
        { source: 'aggregate', count: 0, lastError: 'HTTP 503', lastErrorAt: new Date('2026-01-02') },
      ],
    },
    User: { find, countDocuments: count },
    withTransaction: (fn: () => Promise<unknown>) => fn(),
  };
});
vi.mock('@bike4mind/server-utils/utils/adminAudit', () => ({
  recordAdminActionFromRequest: recordAudit,
  isSelfOrImpersonator: (user: { id?: string } | undefined, id: string) => user?.id === id,
}));
vi.mock('@server/auth/emailVerifiedGrants', () => ({
  isEligibleForFreeCredits: eligible,
  releaseVerifiedPendingFreeCredits: release,
}));
import '@pages/api/admin/signup-domain-holds';

const makeRequest = (body: unknown, user: Record<string, unknown> = { id: 'admin-1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'POST', body });
  Object.assign(req, { user, logger: {} });
  return { req, res };
};
beforeEach(() => {
  reviewUpdate.mockReset().mockResolvedValue({ domain: 'example.net', status: 'held_pending_review' });
  reviewFind.mockReset().mockResolvedValue(null);
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
  recordAudit.mockReset().mockResolvedValue(null);
});
const getList = async (query: Record<string, string> = {}) => {
  const { req, res } = createMocks({ method: 'GET', query });
  Object.assign(req, { user: { id: 'admin-1', isAdmin: true } });
  await handlers.get(req, res);
  return res;
};
const DAY_MS = 24 * 60 * 60 * 1000;

describe('signup domain hold listing', () => {
  beforeEach(() => {
    listed.mockClear();
    countByStatus.mockClear();
    settings.mockReset().mockResolvedValue({});
  });
  it('lists pending holds by default, hiding settled holds older than 90 days', async () => {
    countByStatus.mockResolvedValueOnce({ pending: 3, blocked: 8, released: 1, all: 12 });
    const before = Date.now();
    const res = await getList();
    const [filter, page, limit] = listed.mock.calls[0];
    expect(filter).toMatchObject({ status: 'pending', reason: undefined });
    expect(page).toBe(1);
    expect(limit).toBe(25);
    const { settledSince } = filter as { settledSince: Date };
    expect(settledSince.getTime()).toBeGreaterThanOrEqual(before - 90 * DAY_MS);
    expect(settledSince.getTime()).toBeLessThanOrEqual(Date.now() - 90 * DAY_MS);
    expect(countByStatus).toHaveBeenCalledWith({ reason: undefined, settledSince });
    expect(res._getJSONData()).toMatchObject({
      total: 3,
      counts: { pending: 3, blocked: 8, released: 1, all: 12 },
      settledVisibleDays: 90,
    });
  });
  it.each(['pending', 'blocked', 'released', 'all'] as const)(
    'passes the %s status through with its total',
    async status => {
      countByStatus.mockResolvedValueOnce({ pending: 1, blocked: 2, released: 3, all: 6 });
      const res = await getList({ status, reason: 'young-domain', page: '2' });
      expect(listed).toHaveBeenCalledWith(expect.objectContaining({ status, reason: 'young-domain' }), 2, 25);
      expect(res._getJSONData().total).toBe({ pending: 1, blocked: 2, released: 3, all: 6 }[status]);
    }
  );
  it('shows every settled hold when Include older is on, and uses the configured window otherwise', async () => {
    await getList({ status: 'all', includeOlder: 'true' });
    expect(listed.mock.calls[0][0]).toEqual({ status: 'all', reason: undefined, settledSince: undefined });
    settings.mockResolvedValueOnce({ signupDomainHoldsSettledVisibleDays: 7 });
    const res = await getList({ status: 'blocked' });
    const { settledSince } = listed.mock.calls[1][0] as { settledSince: Date };
    expect(Math.round((Date.now() - settledSince.getTime()) / DAY_MS)).toBe(7);
    expect(res._getJSONData().settledVisibleDays).toBe(7);
  });
  it.each([{ status: 'held' }, { reason: 'anything' }, { includeOlder: 'yes' }, { page: '0' }])(
    'rejects an invalid list query %o',
    async query => {
      await expect(getList(query)).rejects.toThrow('Invalid page, status, reason or includeOlder');
      expect(listed).not.toHaveBeenCalled();
    }
  );
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
  it('returns the advisory assessment stored on a hold', async () => {
    const assessment = {
      outcome: 'judged',
      policyVersion: 1,
      judgment: 'abuse',
      confidence: 0.95,
      model: 'gpt-6-luna',
      assessedAt: new Date('2026-01-02T00:00:00Z'),
    };
    listed.mockResolvedValueOnce([
      {
        domain: 'young.test',
        status: 'blocked',
        reason: 'young-domain (<30 days)',
        triggeredAt: new Date('2026-01-01T00:00:00Z'),
        cohortUserIds: [],
        sampleEmails: [],
        signupCount: 4,
        autoDecision: { policy: 'advisory-decision', decidedAt: new Date('2026-01-02T00:00:00Z') },
        assessment,
      },
    ]);
    const { req, res } = createMocks({ method: 'GET', query: {} });
    Object.assign(req, { user: { id: 'admin-1', isAdmin: true } });
    await handlers.get(req, res);
    expect(res._getJSONData().data[0]).toMatchObject({
      autoDecision: { policy: 'advisory-decision' },
      assessment: { ...assessment, assessedAt: '2026-01-02T00:00:00.000Z' },
    });
  });
});
describe('signup domain hold decisions', () => {
  it('is session-only and declares users:moderate for decisions and a moderation read for the list', () => {
    expect(baseOptions).toHaveBeenCalledWith({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
      adminPermissions: { GET: MODERATION_PAGE_READ, POST: 'users:moderate' },
    });
  });
  it('refuses decisions from a delegate without users:moderate before reading or writing', async () => {
    const delegate = { id: 'mod-1', isAdmin: false, adminPermissions: ['support:read'] };
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' }, delegate);
    await expect(handlers.post(req, res)).rejects.toThrow(missingAdminPermissionMessage('users:moderate'));
    expect(reviewUpdate).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });
  it('admits a users:moderate delegate to confirm a hold', async () => {
    const delegate = { id: 'mod-1', isAdmin: false, adminPermissions: ['users:moderate'] };
    const { req, res } = makeRequest({ domain: 'example.net', action: 'confirm' }, delegate);
    await handlers.post(req, res);
    expect(reviewUpdate).toHaveBeenCalled();
  });
  it('needs credits:adjust to release a hold, since releasing pays pending credits', async () => {
    const delegate = { id: 'mod-1', isAdmin: false, adminPermissions: ['users:moderate'] };
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' }, delegate);
    await expect(handlers.post(req, res)).rejects.toThrow('Missing permission: credits:adjust');
    expect(reviewUpdate).not.toHaveBeenCalled();
  });
  it('never pays a delegate itself or an account with admin access on release', async () => {
    const delegate = { id: 'mod-1', isAdmin: false, adminPermissions: ['users:moderate', 'credits:adjust'] };
    find.mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockResolvedValue([
          { _id: 'mod-1', email: 'me@example.net', tags: [PENDING_FREE_CREDITS_TAG] },
          { _id: 'admin-2', email: 'boss@example.net', tags: [PENDING_FREE_CREDITS_TAG], isAdmin: true },
          {
            _id: 'deleg-3',
            email: 'ops@example.net',
            tags: [PENDING_FREE_CREDITS_TAG],
            adminPermissions: ['support:read'],
          },
          { _id: 'user-4', email: 'user@example.net', tags: [PENDING_FREE_CREDITS_TAG] },
        ]),
      }),
    });
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' }, delegate);
    await handlers.post(req, res);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toMatchObject({ id: 'user-4' });
    expect(res._getJSONData()).toMatchObject({ remaining: 3 });
  });
  it('admits a delegate holding users:moderate and credits:adjust to release', async () => {
    const delegate = { id: 'mod-1', isAdmin: false, adminPermissions: ['users:moderate', 'credits:adjust'] };
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' }, delegate);
    await handlers.post(req, res);
    expect(reviewUpdate).toHaveBeenCalled();
  });
  it('refuses the list to a delegate without a moderation read permission', async () => {
    listed.mockClear();
    const { req, res } = createMocks({ method: 'GET' });
    Object.assign(req, { user: { id: 'mod-1', isAdmin: false, adminPermissions: ['credits:adjust'] } });
    await expect(handlers.get(req, res)).rejects.toThrow(missingAdminPermissionMessage(MODERATION_PAGE_READ));
    expect(listed).not.toHaveBeenCalled();
  });
  it.each(['support:read', 'users:moderate'])('admits a delegate holding %s to the list', async permission => {
    const { req, res } = createMocks({ method: 'GET' });
    Object.assign(req, { user: { id: 'mod-1', isAdmin: false, adminPermissions: [permission] } });
    await handlers.get(req, res);
    expect(res._getStatusCode()).toBe(200);
  });
  it('releases only verified pending users from the reviewed domain and reports remaining work', async () => {
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' });
    await handlers.post(req, res);
    expect(reviewUpdate).toHaveBeenCalledWith(
      { domain: 'example.net', status: { $in: ['held_pending_review', 'blocked'] } },
      {
        $set: { status: 'released', reviewedBy: 'admin-1', reviewedAt: expect.any(Date) },
        $unset: { autoDecision: 1 },
      },
      { new: false }
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
  it('lets an admin release a hold the triage job auto-confirmed, clearing its automated marker', async () => {
    reviewUpdate.mockResolvedValue({
      domain: 'example.net',
      status: 'blocked',
      reason: 'disposable-aggregate',
      autoDecision: { policy: 'disposable-aggregate-rule', decidedAt: new Date() },
    });
    const { req, res } = makeRequest({ domain: 'example.net', action: 'release' });
    await handlers.post(req, res);
    expect(res._getStatusCode()).toBe(200);
    const [filter, update] = reviewUpdate.mock.calls[0];
    expect(filter.status.$in).toContain('blocked');
    expect(update).toMatchObject({
      $set: { status: 'released', reviewedBy: 'admin-1' },
      $unset: { autoDecision: 1 },
    });
    expect(release).toHaveBeenCalled();
    expect(recordAudit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'signup_domain_hold.released',
        changes: [{ field: 'status', before: 'blocked', after: 'released' }],
        details: { reason: 'disposable-aggregate', overrodeAutoDecision: 'disposable-aggregate-rule' },
      })
    );
  });
  it('audits a confirmation and records nothing for a missing hold', async () => {
    reviewUpdate.mockResolvedValue({ domain: 'example.net', status: 'held_pending_review', reason: 'pattern' });
    const confirmed = makeRequest({ domain: 'example.net', action: 'confirm' });
    await handlers.post(confirmed.req, confirmed.res);
    expect(recordAudit).toHaveBeenCalledWith(
      confirmed.req,
      expect.objectContaining({
        action: 'signup_domain_hold.confirmed',
        changes: [{ field: 'status', before: 'held_pending_review', after: 'blocked' }],
        details: { reason: 'pattern' },
      })
    );
    recordAudit.mockClear();
    reviewUpdate.mockResolvedValue(null);
    const missing = makeRequest({ domain: 'example.net', action: 'confirm' });
    await expect(handlers.post(missing.req, missing.res)).rejects.toThrow();
    expect(recordAudit).not.toHaveBeenCalled();
  });
  it.each(['release', 'confirm'] as const)(
    'fails the %s and grants nothing when the audit entry cannot be written',
    async action => {
      reviewUpdate.mockResolvedValue({ domain: 'example.net', status: 'held_pending_review', reason: 'pattern' });
      recordAudit.mockRejectedValueOnce(new Error('audit down'));
      const { req, res } = makeRequest({ domain: 'example.net', action });
      await expect(handlers.post(req, res)).rejects.toThrow('audit down');
      expect(release).not.toHaveBeenCalled();
      expect(find).not.toHaveBeenCalled();
    }
  );
  it('writes no new decision entry when a release is re-posted for an already released hold', async () => {
    reviewFind.mockResolvedValue({
      domain: 'example.net',
      status: 'released',
      reason: 'pattern',
      autoDecision: { policy: 'advisory-decision', decidedAt: new Date() },
    });
    const { req, res } = makeRequest({
      domain: 'example.net',
      action: 'release',
      afterUserId: '000000000000000000000064',
    });
    await handlers.post(req, res);
    expect(recordAudit).not.toHaveBeenCalled();
    // The retry leaves the stored decision (and its auto-release marker) as it was.
    expect(reviewUpdate).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });
  it('records the overridden policy when an admin confirms an auto-confirmed hold', async () => {
    reviewUpdate.mockResolvedValue({
      domain: 'example.net',
      status: 'blocked',
      reason: 'disposable-aggregate',
      autoDecision: { policy: 'disposable-aggregate-rule', decidedAt: new Date() },
    });
    const { req, res } = makeRequest({ domain: 'example.net', action: 'confirm' });
    await handlers.post(req, res);
    expect(recordAudit).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        details: { reason: 'disposable-aggregate', overrodeAutoDecision: 'disposable-aggregate-rule' },
      })
    );
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
