import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const mockRefs = vi.hoisted(() => ({ postHandler: null as null | ((req: any, res: any) => unknown) }));

vi.mock('@server/middlewares/baseApi', () => {
  const chain: any = {
    post: (fn: any) => {
      mockRefs.postHandler = fn;
      return chain;
    },
  };
  return { baseApi: () => chain };
});

const assignUserToGroup = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/services', () => ({ organizationService: { assignUserToGroup } }));
vi.mock('@bike4mind/database/infra', () => ({ organizationRepository: {} }));
vi.mock('@bike4mind/database/social', () => ({ groupRepository: {} }));
vi.mock('@bike4mind/database/auth', () => ({ userRepository: {} }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import '@pages/api/organizations/[id]/groups/[groupId]/members/index';

describe('POST /api/organizations/[id]/groups/[groupId]/members', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records org.group_member.assigned as an organization-scope action', async () => {
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: 'org1', groupId: 'g1' },
      body: { userId: 'member1' },
    });
    (req as any).user = { id: 'admin1' };

    await mockRefs.postHandler!(req, res);

    expect(assignUserToGroup).toHaveBeenCalled();
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.group_member.assigned',
        actorScope: 'organization',
        target: expect.objectContaining({ kind: 'organization', id: 'org1' }),
        details: { groupId: 'g1', targetUserId: 'member1' },
      })
    );
  });

  it('records nothing when the service refuses the assignment', async () => {
    assignUserToGroup.mockRejectedValueOnce(new Error('forbidden'));
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: 'org1', groupId: 'g1' },
      body: { userId: 'member1' },
    });
    (req as any).user = { id: 'admin1' };

    await expect(mockRefs.postHandler!(req, res)).rejects.toThrow('forbidden');
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
