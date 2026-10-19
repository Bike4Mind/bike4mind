import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({ deleteHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    delete: (fn: any) => {
      mockRefs.deleteHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const removeUserFromGroup = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ organizationService: { removeUserFromGroup } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import '@pages/api/organizations/[id]/groups/[groupId]/members/[userId]/index';

describe('DELETE /api/organizations/[id]/groups/[groupId]/members/[userId]', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records org.group_member.unassigned as an organization-scope action', async () => {
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { id: 'org1', groupId: 'g1', userId: 'member1' },
    });
    (req as any).user = { id: 'admin1' };

    await mockRefs.deleteHandler!(req, res);

    expect(removeUserFromGroup).toHaveBeenCalled();
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.group_member.unassigned',
        actorScope: 'organization',
        target: expect.objectContaining({ kind: 'organization', id: 'org1' }),
        details: { groupId: 'g1', targetUserId: 'member1' },
      })
    );
  });

  it('records nothing when the service refuses the removal', async () => {
    removeUserFromGroup.mockRejectedValueOnce(new Error('forbidden'));
    const { req, res } = createMocks({
      method: 'DELETE',
      query: { id: 'org1', groupId: 'g1', userId: 'member1' },
    });
    (req as any).user = { id: 'admin1' };

    await expect(mockRefs.deleteHandler!(req, res)).rejects.toThrow('forbidden');
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
