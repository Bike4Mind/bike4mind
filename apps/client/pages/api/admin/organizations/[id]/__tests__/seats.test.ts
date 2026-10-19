// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ patch: (fn: unknown) => fn }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockSetSeats = vi.fn();
vi.mock('@server/services/organizationService', () => ({
  setSeats: (...args: unknown[]) => mockSetSeats(...args),
  resolveSubscriptionSource: () => 'admin_grant',
}));
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: { findActiveSubscriptionsByOwner: vi.fn().mockResolvedValue([]) },
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import handler from '../seats';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

describe('PATCH /api/admin/organizations/[id]/seats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetSeats.mockResolvedValue({ id: 'org-1', userId: 'owner-1', name: 'Acme', seats: 7 });
  });

  it('records org.seats.changed against the organization', async () => {
    const { req, res } = createMocks({ method: 'PATCH', query: { id: 'org-1' }, body: { seats: 7 } });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };

    await (handler as HandlerFn)(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.seats.changed',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1', displayName: 'Acme' }),
      })
    );
  });
});
