import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/organizations/[id]/groups returns each group's member ids, so it is gated on the
 * MANAGE predicate rather than Permission.read: every org member holds read (addMember writes
 * `permissions: [read]`), and user ids resolve to names through the public profile route, so a
 * read gate would make group membership enumerable by any member.
 *
 * These tests pin the wiring, not the predicate - assertCanManageOrgGroups has its own coverage in
 * organizationService/groupMembership.test.ts. What is asserted here is that this handler calls it,
 * propagates its rejection, and derives memberCount from the ids it actually returns.
 */

const mockRefs = vi.hoisted(() => ({
  getHandler: null as null | ((req: any, res: any) => unknown),
}));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    use: () => chain,
    post: () => chain,
    put: () => chain,
    delete: () => chain,
    get: (fn: any) => {
      mockRefs.getHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const findById = vi.hoisted(() => vi.fn());
const assertCanManageOrgGroups = vi.hoisted(() => vi.fn());
const findByOrganization = vi.hoisted(() => vi.fn());
const findUserIdsByGroupIds = vi.hoisted(() => vi.fn());

vi.mock('@bike4mind/database/infra', () => ({ Organization: { findById } }));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: { findByOrganization } }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: { findUserIdsByGroupIds } }));
vi.mock('@bike4mind/services', () => ({ organizationService: { assertCanManageOrgGroups } }));

import '@pages/api/organizations/[id]/groups/index';

const ORG = { id: 'org1', userId: 'owner1', adminUserIds: [], users: [{ userId: 'u1' }] };

const call = (user: unknown) => {
  const { req, res } = createMocks({ method: 'GET', query: { id: 'org1' } });
  (req as any).user = user;
  return { res, promise: mockRefs.getHandler!(req, res) };
};

describe('GET /api/organizations/[id]/groups', () => {
  beforeEach(() => {
    findById.mockReset().mockResolvedValue(ORG);
    assertCanManageOrgGroups.mockReset();
    findByOrganization.mockReset().mockResolvedValue([{ id: 'g1', name: 'Sales', type: 'sales' }]);
    findUserIdsByGroupIds.mockReset().mockResolvedValue({ g1: ['u1', 'u2'] });
  });

  it('authorizes through the manage predicate, passing the acting user and the org', async () => {
    const { res, promise } = call({ id: 'owner1', isAdmin: false });
    await promise;

    expect(assertCanManageOrgGroups).toHaveBeenCalledWith({ id: 'owner1', isAdmin: false }, ORG);
    expect(res._getStatusCode()).toBe(200);
  });

  it('propagates the predicate rejection instead of returning groups', async () => {
    assertCanManageOrgGroups.mockImplementation(() => {
      throw new Error('Not authorized to manage this org');
    });

    const { promise } = call({ id: 'plainmember', isAdmin: false });
    await expect(promise).rejects.toThrow(/Not authorized/);
    expect(findByOrganization).not.toHaveBeenCalled();
  });

  it('does not authorize or query when the organization does not exist', async () => {
    findById.mockResolvedValue(null);

    const { promise } = call({ id: 'owner1' });
    await expect(promise).rejects.toThrow(/Organization not found/);
    expect(assertCanManageOrgGroups).not.toHaveBeenCalled();
    expect(findByOrganization).not.toHaveBeenCalled();
  });

  it('derives memberCount from the ids it returns, so the two cannot disagree', async () => {
    const { res, promise } = call({ id: 'owner1' });
    await promise;

    const [group] = res._getJSONData().groups;
    expect(group.memberIds).toEqual(['u1', 'u2']);
    expect(group.memberCount).toBe(2);
  });

  it('reports zero members for a group nobody is in', async () => {
    findUserIdsByGroupIds.mockResolvedValue({});

    const { res, promise } = call({ id: 'owner1' });
    await promise;

    const [group] = res._getJSONData().groups;
    expect(group.memberIds).toEqual([]);
    expect(group.memberCount).toBe(0);
  });
});
