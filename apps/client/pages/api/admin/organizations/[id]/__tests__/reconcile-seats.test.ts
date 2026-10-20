// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockReconcile = vi.fn();
vi.mock('@server/services/organizationService', () => ({
  reconcileOrgSeatsFromSubscription: (...args: unknown[]) => mockReconcile(...args),
}));
vi.mock('@server/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@server/utils/adminAudit', () => ({ recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import handler from '../reconcile-seats';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

const organization = { id: 'org-1', userId: 'owner-1', name: 'Acme' };

const run = async () => {
  const { req, res } = createMocks({ method: 'POST', query: { id: 'org-1' } });
  (req as unknown as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };
  await (handler as HandlerFn)(req, res);
  return req;
};

describe('POST /api/admin/organizations/[id]/reconcile-seats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('records org.seats.changed with the seat delta when seats actually change', async () => {
    mockReconcile.mockResolvedValue({ organization, before: 3, after: 6 });

    const req = await run();

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.seats.changed',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1' }),
        changes: [{ field: 'seats', before: 3, after: 6 }],
      })
    );
  });

  it('records nothing for a no-op reconcile', async () => {
    mockReconcile.mockResolvedValue({ organization, before: 6, after: 6 });

    await run();

    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
