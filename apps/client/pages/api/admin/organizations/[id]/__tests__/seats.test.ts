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
  pickPrimarySubscription: (subs: Array<{ subscriptionId?: string }>) => subs[0] ?? null,
}));
const mockFindActiveSubs = vi.fn();
vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findActiveSubscriptionsByOwner: (...a: unknown[]) => mockFindActiveSubs(...a) },
}));
vi.mock('@bike4mind/server-utils/websocket/utils', () => ({ sendToClient: vi.fn() }));
vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  return { ...actual, recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) };
});
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { ADMIN_ACTION_REASON_MISSING_MESSAGE } from '@server/utils/adminAudit';
import handler from '../seats';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

describe('PATCH /api/admin/organizations/[id]/seats', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSetSeats.mockResolvedValue({ id: 'org-1', userId: 'owner-1', name: 'Acme', seats: 7 });
    mockFindActiveSubs.mockResolvedValue([]);
  });

  const makeReq = (body: Record<string, unknown>) => {
    const { req, res } = createMocks({ method: 'PATCH', query: { id: 'org-1' }, body });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };
    return { req, res };
  };

  it('records org.seats.changed against the organization', async () => {
    const { req, res } = makeReq({ seats: 7, reason: 'Billing correction' });

    await (handler as HandlerFn)(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.seats.changed',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1', displayName: 'Acme' }),
        reason: 'Billing correction',
      })
    );
  });

  it("names the resized subscription in the audit details so the subscription's admin log shows it", async () => {
    mockFindActiveSubs.mockResolvedValue([{ subscriptionId: 'admin_grant_1' }]);
    const { req, res } = makeReq({ seats: 7, reason: 'Billing correction' });

    await (handler as HandlerFn)(req, res);

    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({ details: expect.objectContaining({ subscriptionId: 'admin_grant_1' }) })
    );
  });

  it('returns 400 and changes no seats when no reason is sent', async () => {
    const { req, res } = makeReq({ seats: 7 });

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      statusCode: 400,
      message: ADMIN_ACTION_REASON_MISSING_MESSAGE,
    });

    expect(mockSetSeats).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('returns 400 and changes no seats for a too-short reason', async () => {
    const { req, res } = makeReq({ seats: 7, reason: 'abc' });

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({ statusCode: 400 });

    expect(mockSetSeats).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });
});
