import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/organizations/stats previously returned any organization's name and
 * login/export activity to any authenticated caller - an existence-and-name oracle
 * over the whole tenant list. It now intersects caller-supplied ids with the
 * caller's own membership before querying, so an id the caller cannot see is
 * indistinguishable from one that does not exist at all.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

type OrgRecord = { id: string; name: string; users: unknown[] };

// Real ObjectId hex: the route drops ids that could never address a row, so a placeholder like
// 'memberOrg' would be filtered before the membership intersection is what's under test.
const MEMBER_ORG = '507f1f77bcf86cd799439021';
const FOREIGN_ORG = '507f1f77bcf86cd799439022';
const MISSING_ORG = '507f1f77bcf86cd799439023';

const orgCatalog: Record<string, OrgRecord> = {
  [MEMBER_ORG]: { id: MEMBER_ORG, name: 'Member Org', users: [] },
  [FOREIGN_ORG]: { id: FOREIGN_ORG, name: 'Foreign Org', users: [] },
};

type ChainableQuery<T> = Promise<T> & {
  select: () => ChainableQuery<T>;
  populate: () => ChainableQuery<T>;
};

function chainable<T>(result: T): ChainableQuery<T> {
  const query = Promise.resolve(result) as ChainableQuery<T>;
  query.select = () => query;
  query.populate = () => query;
  return query;
}

const find = vi.hoisted(() =>
  vi.fn((filter: { _id: { $in: string[] } }) =>
    chainable(filter._id.$in.map(id => orgCatalog[id]).filter((org): org is OrgRecord => Boolean(org)))
  )
);
const findMembershipOrgIds = vi.hoisted(() => vi.fn(async () => ['507f1f77bcf86cd799439021']));

vi.mock('@bike4mind/database/infra', () => ({
  Organization: { find },
  organizationRepository: { findMembershipOrgIds },
}));
vi.mock('@bike4mind/database/auth', () => ({
  UserActivityCounter: { find: vi.fn(async () => []) },
}));

import '@pages/api/organizations/stats';

function mocks(user: unknown, query: Record<string, unknown> = {}) {
  const { req, res } = createMocks({ method: 'GET', query });
  (req as any).user = user;
  return { req, res };
}

describe('GET /api/organizations/stats - membership-scoped ids', () => {
  beforeEach(() => {
    find.mockClear();
    findMembershipOrgIds.mockClear();
  });

  it('filters out an org id the non-admin caller is not a member of', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { organizationIds: [MEMBER_ORG, FOREIGN_ORG] });
    await mockRefs.getHandler!(req, res);

    const [filter] = find.mock.calls[0];
    expect(filter._id.$in).toEqual([MEMBER_ORG]);

    const body = res._getJSONData();
    expect(FOREIGN_ORG in body).toBe(false);
  });

  it('keeps an org id the non-admin caller IS a member of', async () => {
    const { req, res } = mocks({ id: 'u1', isAdmin: false }, { organizationIds: [MEMBER_ORG] });
    await mockRefs.getHandler!(req, res);

    const body = res._getJSONData();
    expect(body[MEMBER_ORG]).toBeDefined();
    expect(body[MEMBER_ORG].name).toBe('Member Org');
  });

  it('skips the membership intersection entirely for an admin', async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true }, { organizationIds: [MEMBER_ORG, FOREIGN_ORG] });
    await mockRefs.getHandler!(req, res);

    expect(findMembershipOrgIds).not.toHaveBeenCalled();
    const [filter] = find.mock.calls[0];
    expect(filter._id.$in).toEqual([MEMBER_ORG, FOREIGN_ORG]);
  });

  it('answers an unauthorized id and a nonexistent id identically (anti-enumeration)', async () => {
    const user = { id: 'u1', isAdmin: false };

    const unauthorized = mocks(user, { organizationIds: [FOREIGN_ORG] });
    await mockRefs.getHandler!(unauthorized.req, unauthorized.res);
    const bodyForUnauthorized = unauthorized.res._getJSONData();

    const nonexistent = mocks(user, { organizationIds: [MISSING_ORG] });
    await mockRefs.getHandler!(nonexistent.req, nonexistent.res);
    const bodyForNonexistent = nonexistent.res._getJSONData();

    expect(bodyForUnauthorized).toEqual(bodyForNonexistent);
    expect(bodyForUnauthorized).toEqual({});
  });

  it('drops an uncastable id instead of rejecting the whole $in', async () => {
    const { req, res } = mocks({ id: 'admin1', isAdmin: true }, { organizationIds: ['not-an-objectid', MEMBER_ORG] });
    await mockRefs.getHandler!(req, res);

    // One uncastable entry used to reject the entire query, losing the valid rows with it.
    const [filter] = find.mock.calls[0];
    expect(filter._id.$in).toEqual([MEMBER_ORG]);
    expect(res._getJSONData()[MEMBER_ORG]).toBeDefined();
  });
});
