// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => ({ post: (fn: unknown) => fn }),
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mockOrgFindById = vi.fn();
const mockWithTransaction = vi.fn();
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: (...args: unknown[]) => mockOrgFindById(...args) },
  withTransaction: (fn: () => Promise<unknown>) => mockWithTransaction(fn),
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
vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  return { ...actual, recordAdminActionFromRequest: vi.fn().mockResolvedValue(null) };
});
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { recordAdminActionFromRequest } from '@server/utils/adminAudit';
import { sendToClient } from '@server/websocket/utils';
import { ADMIN_ACTION_REASON_MISSING_MESSAGE } from '@server/utils/adminAudit';
import handler from '../revoke';

type HandlerFn = (req: unknown, res: unknown) => Promise<unknown>;

let transactionActive = false;

describe('POST /api/admin/organizations/[id]/revoke', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOrgFindById.mockResolvedValue({ id: 'org-1', userId: 'owner-1', name: 'Acme' });
    mockFindActiveByOwner.mockResolvedValue([{ id: 'sub-1' }]);
    transactionActive = false;
    mockWithTransaction.mockImplementation(async (fn: () => Promise<unknown>) => {
      transactionActive = true;
      try {
        return await fn();
      } finally {
        transactionActive = false;
      }
    });
  });

  it('fails the request without notifying when the strict audit write fails', async () => {
    vi.mocked(recordAdminActionFromRequest).mockImplementationOnce(async () => {
      expect(transactionActive).toBe(true);
      throw new Error('audit down');
    });
    const { req, res } = createMocks({
      method: 'POST',
      query: { id: 'org-1' },
      body: { reason: 'Billing correction' },
    });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };

    await expect((handler as HandlerFn)(req, res)).rejects.toThrow('audit down');

    expect(mockWithTransaction).toHaveBeenCalledTimes(1);
    expect(sendToClient).not.toHaveBeenCalled();
  });

  it('returns 400 and revokes nothing when no reason is sent', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: 'org-1' }, body: {} });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({
      statusCode: 400,
      message: ADMIN_ACTION_REASON_MISSING_MESSAGE,
    });

    expect(mockSubUpdate).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('returns 400 and revokes nothing for a too-short reason', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: 'org-1' }, body: { reason: 'abc' } });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };

    await expect((handler as HandlerFn)(req, res)).rejects.toMatchObject({ statusCode: 400 });

    expect(mockSubUpdate).not.toHaveBeenCalled();
    expect(recordAdminActionFromRequest).not.toHaveBeenCalled();
  });

  it('records org.revoked against the organization after cancelling the grant', async () => {
    vi.mocked(recordAdminActionFromRequest).mockImplementationOnce(async () => {
      expect(transactionActive).toBe(true);
      return null;
    });
    const { req, res } = createMocks({ method: 'POST', query: { id: 'org-1' }, body: { reason: 'Contract ended' } });
    (req as unknown as Record<string, unknown>).user = { id: 'admin-1', username: 'admin', isAdmin: true };

    await (handler as HandlerFn)(req, res);

    expect(mockSubUpdate).toHaveBeenCalledWith(expect.objectContaining({ id: 'sub-1', status: 'canceled' }));
    expect(recordAdminActionFromRequest).toHaveBeenCalledWith(
      req,
      expect.objectContaining({
        action: 'org.revoked',
        target: expect.objectContaining({ kind: 'organization', id: 'org-1', displayName: 'Acme' }),
        reason: 'Contract ended',
      })
    );
    expect(mockSubUpdate.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(recordAdminActionFromRequest).mock.invocationCallOrder[0]
    );
  });
});
