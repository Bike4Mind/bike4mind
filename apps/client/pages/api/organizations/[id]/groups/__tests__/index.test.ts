import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

/**
 * GET /api/organizations/[id]/groups now delegates to organizationService.listOrganizationGroups,
 * which owns the org fetch, the MANAGE authorization, and the member assembly (org-groups #1225).
 * These tests pin only the route wiring - extract the id, delegate with the acting user, return the
 * result, and 404 before delegating when the id is absent. The authorization and assembly behaviour
 * is covered in organizationService/groupMembership.test.ts.
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

const listOrganizationGroups = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/database', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@bike4mind/services', () => ({ organizationService: { listOrganizationGroups } }));

import '@pages/api/organizations/[id]/groups/index';

const RESULT = [{ id: 'g1', name: 'Sales', type: 'sales', memberIds: ['u1', 'u2'], memberCount: 2 }];

// `null` = omit the id entirely (passing `undefined` would trigger the default and send 'org1').
const call = (user: unknown, id: string | null = 'org1') => {
  const { req, res } = createMocks({ method: 'GET', query: id === null ? {} : { id } });
  (req as any).user = user;
  return { res, promise: mockRefs.getHandler!(req, res) };
};

describe('GET /api/organizations/[id]/groups', () => {
  beforeEach(() => {
    listOrganizationGroups.mockReset().mockResolvedValue(RESULT);
  });

  it('delegates to organizationService.listOrganizationGroups with the acting user and org id', async () => {
    const user = { id: 'owner1', isAdmin: false };
    const { res, promise } = call(user);
    await promise;

    expect(listOrganizationGroups).toHaveBeenCalledWith(
      user,
      { organizationId: 'org1' },
      expect.objectContaining({ db: expect.anything() })
    );
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData().groups).toEqual(RESULT);
  });

  it('propagates a service rejection (e.g. the authorization failure) instead of returning groups', async () => {
    listOrganizationGroups.mockRejectedValue(new Error('Not authorized to manage this organization'));

    const { promise } = call({ id: 'plainmember', isAdmin: false });
    await expect(promise).rejects.toThrow(/Not authorized/);
  });

  it('404s without delegating when the id is missing', async () => {
    const { promise } = call({ id: 'owner1' }, null);
    await expect(promise).rejects.toThrow(/Organization not found/);
    expect(listOrganizationGroups).not.toHaveBeenCalled();
  });
});
