import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { BadRequestError, ForbiddenError } from '@server/utils/errors';

/**
 * PUT /api/organizations/[id]/admins sets `adminUserIds`, gated to the billing owner or a platform
 * admin. The eligibility half is the interesting one: an appointee must hold an ACL row that
 * actually CONFERS membership, not merely a row that exists.
 *
 * That is the write-time half of #2005. Checking `userId` alone let a permission-less row pass
 * appointment and then fail `findMembershipOrgIds`, minting a principal with admin rights over an
 * org that was unselectable in their own account switcher. The read-time half - such a principal
 * still being able to DISCOVER the org's lakes - is pinned in
 * `DataLakeModel.orgScopeAgreement.test.ts`.
 */

const mockRefs = vi.hoisted(() => ({
  putHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    get: () => chain,
    post: () => chain,
    delete: () => chain,
    put: (fn: any) => {
      mockRefs.putHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const findById = vi.hoisted(() => vi.fn());
const update = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: { findById, update } }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@server/utils/auditLog', () => ({
  AdminOrgAuditEvents: { ORG_ADMINS_UPDATED: 'ORG_ADMINS_UPDATED' },
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

import '@pages/api/organizations/[id]/admins';

/** An org owned by `owner1`, whose `users[]` roster is supplied per test. */
const org = (users: { userId: string; permissions?: string[] }[]) => ({
  id: 'org1',
  userId: 'owner1',
  users,
});

const put = (adminUserIds: string[], user = { id: 'owner1', isAdmin: false }) => {
  const { req, res } = createMocks({ method: 'PUT', query: { id: 'org1' }, body: { adminUserIds } });
  (req as any).user = user;
  return { req: req as any, res, run: () => mockRefs.putHandler!(req, res) };
};

describe('PUT /api/organizations/[id]/admins - appointee eligibility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    update.mockImplementation(async ({ adminUserIds }: { adminUserIds: string[] }) => ({ adminUserIds }));
  });

  it('appoints a member whose ACL row grants read', async () => {
    findById.mockResolvedValue(org([{ userId: 'member1', permissions: ['read'] }]));

    const { res, run } = put(['member1']);
    await run();

    expect(update).toHaveBeenCalledWith({ id: 'org1', adminUserIds: ['member1'] });
    expect(res._getStatusCode()).toBe(200);
  });

  // The #2005 write-time gap. The appointment route is the only way to reach `adminUserIds`, so
  // refusing here is what stops the divergent state from being created at all.
  it('refuses a member whose ACL row carries no permissions, and does not write', async () => {
    findById.mockResolvedValue(org([{ userId: 'member1' }]));

    const { run } = put(['member1']);

    await expect(run()).rejects.toThrow(BadRequestError);
    expect(update).not.toHaveBeenCalled();
  });

  // A share-only row is not membership either - `orgMembershipFilter` excludes it, and this route
  // has to agree or the same divergence reappears through a different permission value.
  it('refuses a member whose ACL row grants only share', async () => {
    findById.mockResolvedValue(org([{ userId: 'member1', permissions: ['share'] }]));

    const { run } = put(['member1']);

    await expect(run()).rejects.toThrow(BadRequestError);
    expect(update).not.toHaveBeenCalled();
  });

  it('names only the ineligible appointees in the error, and rejects the whole batch', async () => {
    findById.mockResolvedValue(
      org([
        { userId: 'good1', permissions: ['read'] },
        { userId: 'bad1', permissions: [] },
      ])
    );

    const { run } = put(['good1', 'bad1']);

    // Whole-batch refusal, not a partial write: the route is a full REPLACE of adminUserIds, so
    // persisting the eligible half would silently de-appoint whoever the caller did not resend.
    await expect(run()).rejects.toThrow(/bad1/);
    expect(update).not.toHaveBeenCalled();
  });

  // Eligibility binds what this call ADDS, not the roster's history. PUT is a full replace, so a
  // sitting admin is resent on every save; refusing them would let one row appointed before the
  // check existed block every later edit of the roster (#2005).
  it('grandfathers a sitting admin whose ACL row confers no membership', async () => {
    findById.mockResolvedValue({
      ...org([{ userId: 'legacy1' }, { userId: 'member1', permissions: ['read'] }]),
      adminUserIds: ['legacy1'],
    });

    const { res, run } = put(['legacy1', 'member1']);
    await run();

    expect(update).toHaveBeenCalledWith({ id: 'org1', adminUserIds: ['legacy1', 'member1'] });
    expect(res._getStatusCode()).toBe(200);
  });

  // The grandfather clause must not become a hole: it waives the permissions requirement for an
  // existing appointment only, never for a new one arriving in the same batch.
  it('still refuses a NEW permission-less appointee alongside a grandfathered one', async () => {
    findById.mockResolvedValue({
      ...org([{ userId: 'legacy1' }, { userId: 'bad1' }]),
      adminUserIds: ['legacy1'],
    });

    const { run } = put(['legacy1', 'bad1']);

    // Names bad1 and only bad1 - the grandfathered id is not an error the operator must act on.
    await expect(run()).rejects.toThrow(/^Not organization members with read access: bad1$/);
    expect(update).not.toHaveBeenCalled();
  });

  // Roster membership is not waived by the grandfather clause. A sitting admin removed from the org
  // entirely has no users[] row, so resending them is still an outsider reference.
  it('does not grandfather a sitting admin who has been removed from the roster', async () => {
    findById.mockResolvedValue({
      ...org([{ userId: 'member1', permissions: ['read'] }]),
      adminUserIds: ['departed1'],
    });

    const { run } = put(['departed1', 'member1']);

    await expect(run()).rejects.toThrow(/departed1/);
    expect(update).not.toHaveBeenCalled();
  });

  it('still refuses a user with no ACL row at all (the pre-existing outsider check)', async () => {
    findById.mockResolvedValue(org([{ userId: 'member1', permissions: ['read'] }]));

    const { run } = put(['outsider']);

    await expect(run()).rejects.toThrow(BadRequestError);
    expect(update).not.toHaveBeenCalled();
  });

  it('rejects a non-owner, non-admin before reading the roster', async () => {
    findById.mockResolvedValue(org([{ userId: 'member1', permissions: ['read'] }]));

    const { run } = put(['member1'], { id: 'intruder', isAdmin: false });

    await expect(run()).rejects.toThrow(ForbiddenError);
    expect(update).not.toHaveBeenCalled();
  });

  it('lets a platform admin appoint an eligible member', async () => {
    findById.mockResolvedValue(org([{ userId: 'member1', permissions: ['read'] }]));

    const { run } = put(['member1'], { id: 'someone-else', isAdmin: true });
    await run();

    expect(update).toHaveBeenCalledWith({ id: 'org1', adminUserIds: ['member1'] });
  });
});
