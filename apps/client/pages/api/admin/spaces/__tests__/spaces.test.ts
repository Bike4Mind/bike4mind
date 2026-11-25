// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Request, Response } from 'express';
import { createMocks } from 'node-mocks-http';

type Handler = (req: Request, res: Response) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  handlers: {} as Record<string, Handler>,
  permissions: [] as Record<string, unknown>[],
  txRuns: 0,
  findLiveById: vi.fn(),
  searchAll: vi.fn(),
  findByIds: vi.fn(),
  findAllByEmailsOrUsernames: vi.fn(),
  countBySpace: vi.fn(),
  listBySpace: vi.fn(),
  findAllByDocumentId: vi.fn(),
  adminRemove: vi.fn(),
  adminRemoveMember: vi.fn(),
  audit: vi.fn(),
  notifyOwner: vi.fn(),
}));

vi.mock('@server/middlewares/adminApi', () => ({
  adminApi: (options: { adminPermissions: Record<string, unknown> }) => {
    mocks.permissions.push(options.adminPermissions);
    const chain: Record<string, unknown> = { use: () => chain };
    for (const method of ['get', 'delete']) {
      chain[method] = (fn: Handler) => {
        mocks.handlers[`${mocks.permissions.length}:${method.toUpperCase()}`] = fn;
        return chain;
      };
    }
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: Handler) => fn }));
vi.mock('@bike4mind/server-utils/middlewares/rateLimit', () => ({ rateLimit: () => (_r: unknown) => undefined }));
vi.mock('@bike4mind/database', () => ({
  spaceRepository: { findLiveById: mocks.findLiveById, searchAll: mocks.searchAll },
  userRepository: { findByIds: mocks.findByIds, findAllByEmailsOrUsernames: mocks.findAllByEmailsOrUsernames },
  orgDomainClaimRepository: { countBySpace: mocks.countBySpace, listBySpace: mocks.listBySpace },
  inviteRepository: { findAllByDocumentId: mocks.findAllByDocumentId },
  withTransaction: async (fn: () => Promise<unknown>) => {
    mocks.txRuns += 1;
    return fn();
  },
}));
vi.mock('@bike4mind/services', () => ({
  spaceService: { adminRemove: mocks.adminRemove, adminRemoveMember: mocks.adminRemoveMember },
}));
vi.mock('@bike4mind/server-utils/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@bike4mind/server-utils/utils/adminAudit')>();
  return {
    ...actual,
    recordAdminActionFromRequest: mocks.audit,
    userAuditTarget: async (id: string) => ({ kind: 'user', id, displayName: 'ada@example.com' }),
  };
});
vi.mock('@server/spaces/adminSpaces', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/spaces/adminSpaces')>();
  return { ...actual, notifyOwnerSpaceDeletedByAdmin: mocks.notifyOwner };
});

await import('../index');
await import('../[id]/index');
await import('../[id]/members/[userId]');

const LIST = '1:GET';
const DETAIL_GET = '2:GET';
const DETAIL_DELETE = '2:DELETE';
const MEMBER_DELETE = '3:DELETE';

const SPACE = '650000000000000000000aaa';
const OWNER = '650000000000000000000002';
const MEMBER = '650000000000000000000001';

const buildSpace = () => ({
  id: SPACE,
  name: 'Team Space',
  ownerUserId: OWNER,
  members: [{ userId: MEMBER, role: 'member', joinedAt: new Date(), joinedVia: 'invite' }],
  createdAt: new Date(),
});

const call = async (
  key: string,
  { body, query = {}, isAdmin = true }: { body?: unknown; query?: Record<string, string>; isAdmin?: boolean } = {}
) => {
  const { req, res } = createMocks({ body, query: { id: SPACE, userId: MEMBER, ...query } });
  const request = Object.assign(req, {
    user: { id: 'admin1', username: 'admin', isAdmin, adminPermissions: ['users:moderate'] },
    logger: { info: vi.fn(), warn: vi.fn() },
  }) as unknown as Request;
  await mocks.handlers[key](request, res as unknown as Response);
  return res;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.txRuns = 0;
  mocks.findLiveById.mockResolvedValue(buildSpace());
  mocks.searchAll.mockResolvedValue({ data: [buildSpace()], total: 1 });
  mocks.findByIds.mockResolvedValue([{ id: OWNER, username: 'owner', email: 'owner@example.com' }]);
  mocks.findAllByEmailsOrUsernames.mockResolvedValue([]);
  mocks.countBySpace.mockResolvedValue(2);
  mocks.listBySpace.mockResolvedValue([]);
  mocks.findAllByDocumentId.mockResolvedValue([]);
  mocks.adminRemove.mockResolvedValue(buildSpace());
  mocks.adminRemoveMember.mockResolvedValue(buildSpace());
  mocks.audit.mockResolvedValue({});
});

describe('admin Space routes', () => {
  it('declare users:moderate on every method', () => {
    expect(mocks.permissions).toEqual([
      { GET: 'users:moderate' },
      { GET: 'users:moderate', DELETE: 'users:moderate' },
      { DELETE: 'users:moderate' },
    ]);
  });

  it.each([
    [LIST, undefined],
    [DETAIL_GET, undefined],
    [DETAIL_DELETE, { reason: 'Abuse' }],
    [MEMBER_DELETE, { reason: 'Abuse' }],
  ])('refuses a delegated admin on %s', async (key, body) => {
    await expect(call(key, { body, isAdmin: false })).rejects.toMatchObject({ statusCode: 403 });
    expect(mocks.searchAll).not.toHaveBeenCalled();
    expect(mocks.adminRemove).not.toHaveBeenCalled();
    expect(mocks.adminRemoveMember).not.toHaveBeenCalled();
  });

  it('lists Spaces with owner email and counts, with no feature flag involved', async () => {
    const res = await call(LIST, { query: { search: 'team' } });
    const json = res._getJSONData();
    expect(json.total).toBe(1);
    expect(json.spaces[0]).toMatchObject({
      id: SPACE,
      memberCount: 2,
      domainCount: 2,
      owner: { id: OWNER, email: 'owner@example.com' },
    });
    expect(mocks.searchAll).toHaveBeenCalledWith(expect.objectContaining({ search: 'team', page: 1, limit: 25 }));
  });

  describe('DELETE /api/admin/spaces/[id]', () => {
    it('requires a reason and deletes nothing without one', async () => {
      await expect(call(DETAIL_DELETE, { body: {} })).rejects.toMatchObject({ statusCode: 400 });
      expect(mocks.adminRemove).not.toHaveBeenCalled();
    });

    it('deletes, audits in the same transaction, then notifies the owner', async () => {
      const res = await call(DETAIL_DELETE, { body: { reason: 'Abuse' } });
      expect(res._getJSONData()).toEqual({ id: SPACE });
      expect(mocks.txRuns).toBe(1);
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'space.deleted',
          target: expect.objectContaining({ kind: 'space', id: SPACE }),
        })
      );
      expect(mocks.notifyOwner).toHaveBeenCalledTimes(1);
    });

    it('rolls back and sends no notice when the audit write fails', async () => {
      mocks.audit.mockRejectedValue(new Error('audit down'));
      await expect(call(DETAIL_DELETE, { body: { reason: 'Abuse' } })).rejects.toThrow('audit down');
      expect(mocks.notifyOwner).not.toHaveBeenCalled();
    });
  });

  describe('DELETE /api/admin/spaces/[id]/members/[userId]', () => {
    it('requires a reason', async () => {
      await expect(call(MEMBER_DELETE, { body: {} })).rejects.toMatchObject({ statusCode: 400 });
      expect(mocks.adminRemoveMember).not.toHaveBeenCalled();
    });

    it('removes and audits in one transaction', async () => {
      const res = await call(MEMBER_DELETE, { body: { reason: 'Abuse' } });
      expect(res._getJSONData()).toEqual({ spaceId: SPACE, userId: MEMBER });
      expect(mocks.txRuns).toBe(1);
      expect(mocks.audit).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'space.member.removed' })
      );
    });

    it('fails from inside the transaction when the audit write fails', async () => {
      mocks.audit.mockRejectedValue(new Error('audit down'));
      await expect(call(MEMBER_DELETE, { body: { reason: 'Abuse' } })).rejects.toThrow('audit down');
    });
  });
});
