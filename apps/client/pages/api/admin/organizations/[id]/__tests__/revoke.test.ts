// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockOrgFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockOrgFindById(...args) },
}));

const mockFindActiveByOwner = vi.fn();
const mockSubUpdate = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findActiveSubscriptionsByOwner: (...args: unknown[]) => mockFindActiveByOwner(...args),
    update: (...args: unknown[]) => mockSubUpdate(...args),
  },
}));
vi.mock('@server/services/organizationService', () => ({ resolveSubscriptionSource: () => 'admin_grant' }));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import handler from '../revoke';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

describe('POST /api/admin/organizations/[id]/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindById.mockResolvedValue({ id: 'org-1', userId: 'owner-1', name: 'Acme' });
    mockFindActiveByOwner.mockResolvedValue([{ id: 'sub-1' }]);
  });

  it('records org.revoked against the organization after cancelling the grant', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: 'org-1' }, body: { reason: 'contract ended' } });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };

    await (handler as HandlerFn)(req, res);

    expect(mockSubUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'sub-1', status: 'canceled' }));
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.revoked',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1', displayName: 'Acme' }),
        reason: 'contract ended',
      })
    );
    expect(mockSubUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(recordAdminActionFromRequest).mock.invocationCallOrder[0]
    );
  });
});
