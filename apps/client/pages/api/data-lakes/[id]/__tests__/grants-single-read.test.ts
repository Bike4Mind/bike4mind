import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * The read-count guard for the grant door. Unlike the sibling `grants.test.ts`, this drives the REAL
 * `@bike4mind/services` and mocks only the repositories, because the thing under test is how many
 * times the route + service pair touch them: the access gate and the manage gate each used to
 * resolve the lake and its active grants for themselves, so a single grant cost four round-trips.
 * Counting the repository calls is what makes "two, not four" a measurement rather than a reading of
 * the call graph - both counts below are 2 if either gate goes back to resolving its own copy.
 *
 * The counts alone would pass on a gate that read the right pair and then handed the door the wrong
 * one, so each case also pins WHAT was read (`activeAsOf`, without which a lapsed curator or owner
 * grant becomes live for the manage decision) and the curator case below pins that the grants the
 * gate read are the ones the door actually decides on.
 */
const repos = vi.hoisted(() => ({
  findById: vi.fn(),
  findBySlug: vi.fn(),
  listByLake: vi.fn(),
  listByPrincipal: vi.fn(),
  findGrant: vi.fn(),
  upsertGrant: vi.fn(),
  removeGrant: vi.fn(),
  findAllByEmailsOrUsernames: vi.fn(),
  record: vi.fn(),
  toAccessContext: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const routes: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign((req: { method?: string }, res: unknown) => routes[req.method ?? 'POST']?.(req, res), {
      use: () => chain,
      post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.POST = fns[fns.length - 1]), chain),
      delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((routes.DELETE = fns[fns.length - 1]), chain),
    });
    return chain;
  },
}));
vi.mock('@server/middlewares/featureFlag', () => ({ requireFeatureEnabled: () => () => {} }));
vi.mock('@server/dataLakes/toAccessContext', () => ({ toAccessContext: repos.toAccessContext }));
vi.mock('@bike4mind/database', () => ({
  dataLakeRepository: { findById: repos.findById, findBySlug: repos.findBySlug },
  dataLakeAccessGrantRepository: {
    listByLake: repos.listByLake,
    listByPrincipal: repos.listByPrincipal,
    findGrant: repos.findGrant,
    upsertGrant: repos.upsertGrant,
    removeGrant: repos.removeGrant,
  },
  userRepository: { findAllByEmailsOrUsernames: repos.findAllByEmailsOrUsernames },
  lakeConfigChangeEventRepository: { record: repos.record },
  adminSettingsRepository: {
    findBySettingNames: vi.fn().mockResolvedValue([]),
    findAll: vi.fn().mockResolvedValue([]),
  },
}));

import handler from '../grants';

const OWNER = 'owner-1';
const CURATOR = 'curator-1';
const LAKE = { id: 'lake-oid-1', slug: 'my-lake', createdByUserId: OWNER, organizationId: undefined };

const makeRes = () => {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  return { res: { json, status } as never, json };
};
const call = (req: unknown, res: unknown) => (handler as (req: unknown, res: unknown) => Promise<void>)(req, res);

describe('/api/data-lakes/[id]/grants read counts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repos.toAccessContext.mockResolvedValue({
      userId: OWNER,
      isAdmin: false,
      organizationIds: [],
      administeredOrgIds: [],
      userTags: [],
      entitlementKeys: [],
    });
    repos.findById.mockResolvedValue(LAKE);
    repos.findBySlug.mockResolvedValue(null);
    repos.listByLake.mockResolvedValue([]);
    repos.listByPrincipal.mockResolvedValue([]);
    repos.findGrant.mockResolvedValue(null);
    repos.upsertGrant.mockResolvedValue({});
    repos.removeGrant.mockResolvedValue(true);
    repos.findAllByEmailsOrUsernames.mockResolvedValue([{ id: 'u2' }]);
    repos.record.mockResolvedValue({});
  });

  it('resolves the lake and its grants exactly once on a grant', async () => {
    const { res } = makeRes();
    await call(
      {
        method: 'POST',
        query: { id: LAKE.id },
        body: { principalType: 'user', principalEmail: 'u2@example.com', role: 'reader' },
        user: { id: OWNER },
      },
      res
    );

    expect(repos.upsertGrant).toHaveBeenCalledTimes(1);
    expect(repos.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ dataLakeId: LAKE.id, principalId: 'u2', role: 'reader' })
    );
    expect(repos.findById).toHaveBeenCalledTimes(1);
    expect(repos.listByLake).toHaveBeenCalledTimes(1);
    expect(repos.listByLake).toHaveBeenCalledWith(LAKE.id, { activeAsOf: expect.any(Date) });
  });

  it('resolves the lake and its grants exactly once on a revoke', async () => {
    repos.findGrant.mockResolvedValue({ principalType: 'user', principalId: 'u2', role: 'reader' });
    const { res } = makeRes();
    await call(
      {
        method: 'DELETE',
        query: { id: LAKE.id, principalType: 'user', principalId: 'u2' },
        user: { id: OWNER },
      },
      res
    );

    expect(repos.removeGrant).toHaveBeenCalledTimes(1);
    expect(repos.removeGrant).toHaveBeenCalledWith(LAKE.id, 'user', 'u2');
    expect(repos.findById).toHaveBeenCalledTimes(1);
    expect(repos.listByLake).toHaveBeenCalledTimes(1);
    expect(repos.listByLake).toHaveBeenCalledWith(LAKE.id, { activeAsOf: expect.any(Date) });
  });

  // The seam itself: a curator who is NOT the lake's creator reaches the manage gate ONLY through a
  // grant row, and the door is now pure over the grants the gate handed it. So a gate that reads the
  // grants and then returns the wrong set (`[]`, say) still passes every count above while silently
  // dropping every grant-carried rung - this case is what fails when that happens.
  it('decides the manage gate on the grants the access gate read', async () => {
    repos.toAccessContext.mockResolvedValue({
      userId: CURATOR,
      isAdmin: false,
      organizationIds: [],
      administeredOrgIds: [],
      userTags: [],
      entitlementKeys: [],
    });
    repos.listByLake.mockResolvedValue([{ principalType: 'user', principalId: CURATOR, role: 'curator' }]);
    const { res } = makeRes();

    await call(
      {
        method: 'POST',
        query: { id: LAKE.id },
        body: { principalType: 'user', principalEmail: 'u2@example.com', role: 'reader' },
        user: { id: CURATOR },
      },
      res
    );

    expect(repos.upsertGrant).toHaveBeenCalledWith(
      expect.objectContaining({ dataLakeId: LAKE.id, principalId: 'u2', grantedByUserId: CURATOR })
    );
    expect(repos.listByLake).toHaveBeenCalledTimes(1);
  });

  // A registry lake resolves to a synthetic document whose id is its slug, so the door's own second
  // findById used to run against that slug and refuse first - with the wrong refusal. With one read
  // the request reaches assertLakeGrantable, which is the refusal that names why it cannot be shared.
  it('refuses a registry lake by saying it is built into the platform', async () => {
    const { DATA_LAKES } = await import('@bike4mind/common');
    // Admin, so the registry lake resolves past the fallback's own tag/entitlement gate and the
    // request reaches the refusal this case is about rather than a not-found.
    repos.toAccessContext.mockResolvedValue({
      userId: OWNER,
      isAdmin: true,
      organizationIds: [],
      administeredOrgIds: [],
      userTags: [],
      entitlementKeys: [],
    });
    repos.findById.mockResolvedValue(null);
    repos.findBySlug.mockResolvedValue(null);
    const { res } = makeRes();

    await expect(
      call(
        {
          method: 'POST',
          query: { id: DATA_LAKES[0].id },
          body: { principalType: 'user', principalEmail: 'u2@example.com', role: 'reader' },
          user: { id: OWNER },
        },
        res
      )
    ).rejects.toThrow(/built into the platform/i);
    expect(repos.upsertGrant).not.toHaveBeenCalled();
  });
});
