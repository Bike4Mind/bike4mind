import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';

// Captures the config so a test can assert requiredScopes: the scope gate lives in
// apiKeyAuth (real middleware, not exercised here), so asserting the handler is
// registered with it is the only guard available at this level.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'PUT']?.(req, res),
      {
        use: () => chain,
        put: (fn: (req: unknown, res: unknown) => unknown) => ((h.PUT = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@bike4mind/server-utils/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

const mockUserFindById = vi.fn();
const mockOrgFindById = vi.fn();
let inTransaction = false;
let insideTransactionAtAudit: boolean | undefined;
vi.mock('@bike4mind/database', () => ({
  organizationRepository: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  userRepository: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  withTransaction: async (fn: (session: unknown) => Promise<unknown>) => {
    inTransaction = true;
    try {
      return await fn(undefined);
    } finally {
      inTransaction = false;
    }
  },
}));

const mockRecordAdminAction = vi.fn();
vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  return {
    ...actual,
    recordAdminActionFromRequest: (...a: unknown[]) => {
      insideTransactionAtAudit = inTransaction;
      return mockRecordAdminAction(...a);
    },
  };
});
vi.mock('@bike4mind/server-utils/services/teamPlanSettings', () => ({
  getTeamPlanSettings: vi.fn(async () => ({ minSeats: 3, maxSeats: 8, creditsPerSeat: 1000 })),
}));

const mockFindByStripeSubId = vi.fn();
const mockUpdateByStripeSubId = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findByStripeSubscriptionId: (...a: unknown[]) => mockFindByStripeSubId(...a),
    updateByStripeSubscriptionId: (...a: unknown[]) => mockUpdateByStripeSubId(...a),
  },
}));

const mockSendToClient = vi.fn();
vi.mock('@server/websocket/utils', () => ({ sendToClient: (...a: unknown[]) => mockSendToClient(...a) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { ADMIN_ACTION_REASON_MISSING_MESSAGE } from '@server/utils/adminAudit';
import handler from '../credits';

function call(options: { isAdmin?: boolean; body?: object; userId?: string; subscriptionId?: string }) {
  const { req, res } = createMocks({
    method: 'PUT',
    query: { userId: options.userId ?? 'u1', subscriptionId: options.subscriptionId ?? 'sub_123' },
    body: options.body ?? { creditsPerCycle: 5000, reason: 'Billing correction' },
  });
  (req as unknown as { user: { isAdmin: boolean; id: string } }).user = {
    isAdmin: options.isAdmin ?? true,
    id: 'admin-1',
  };
  (req as unknown as { logger: unknown }).logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

describe('PUT /api/admin/users/[userId]/subscriptions/[subscriptionId]/credits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUserFindById.mockResolvedValue({ id: 'u1' });
    mockFindByStripeSubId.mockResolvedValue({ id: 'sub-1', ownerType: 'User', ownerId: 'u1' });
    mockUpdateByStripeSubId.mockResolvedValue(undefined);
    mockRecordAdminAction.mockResolvedValue(null);
    insideTransactionAtAudit = undefined;
  });

  it('requires the ADMIN scope so an under-scoped admin-owned key is 403d by apiKeyAuth', () => {
    // Pins the whole config object, not just requiredScopes - a sibling `auth: false`
    // would skip baseApi's entire api-key chain (baseApi.ts's `if (resolvedOptions.auth)`)
    // and disable this gate while leaving requiredScopes untouched.
    const config = (handler as unknown as { _config?: unknown })._config;
    expect(config).toEqual({ requiredScopes: [ApiKeyScope.ADMIN] });
  });

  it('rejects a non-admin', async () => {
    const { run } = call({ isAdmin: false });
    await expect(run()).rejects.toThrow(/[Aa]dmin/);
    expect(mockUpdateByStripeSubId).not.toHaveBeenCalled();
  });

  it('returns 400 and updates nothing when no reason is sent', async () => {
    const { res, run } = call({ body: { creditsPerCycle: 5000 } });

    await expect(run()).rejects.toMatchObject({ statusCode: 400, message: ADMIN_ACTION_REASON_MISSING_MESSAGE });

    expect(mockUpdateByStripeSubId).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).not.toHaveBeenCalled();
    expect(res._getData()).toBe('');
  });

  it('returns 400 and updates nothing for a too-short reason', async () => {
    const { run } = call({ body: { creditsPerCycle: 5000, reason: 'abc' } });

    await expect(run()).rejects.toMatchObject({ statusCode: 400 });

    expect(mockUpdateByStripeSubId).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).not.toHaveBeenCalled();
  });

  it('updates the credit rate for an individual subscription for an admin', async () => {
    const { res, run } = call({});
    await run();
    expect(mockUpdateByStripeSubId).toHaveBeenCalledWith('sub_123', { customCreditsPerCycle: 5000 });
    expect(res._getJSONData()).toMatchObject({ success: true, creditsPerCycle: 5000 });
  });

  describe('admin audit', () => {
    it('records user.credits.adjusted with the signed rate change inside the transaction', async () => {
      mockUserFindById.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });
      mockFindByStripeSubId.mockResolvedValue({
        id: 'sub-1',
        ownerType: 'User',
        ownerId: 'u1',
        priceId: 'price_unknown',
        customCreditsPerCycle: 8000,
      });

      const { run } = call({});
      await run();

      expect(insideTransactionAtAudit).toBe(true);
      expect(mockRecordAdminAction).toHaveBeenCalledTimes(1);
      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.credits.adjusted',
          target: { kind: 'user', id: 'u1', displayName: 'u1@example.com' },
          changes: [{ field: 'customCreditsPerCycle', before: 8000, after: 5000 }],
          details: expect.objectContaining({ credits: -3000, subscriptionId: 'sub_123' }),
        })
      );
    });

    it('derives a team rate change from the seat default and tags the organization', async () => {
      mockFindByStripeSubId.mockResolvedValue({
        id: 'sub-1',
        ownerType: 'Organization',
        ownerId: 'org-1',
        quantity: 3,
      });
      mockOrgFindById.mockResolvedValue({ id: 'org-1', name: 'Acme', users: [] });

      const { run } = call({});
      await run();

      expect(insideTransactionAtAudit).toBe(true);
      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.credits.adjusted',
          organizationId: 'org-1',
          details: expect.objectContaining({ credits: 2000, previousCreditsPerCycle: 3000 }),
        })
      );
    });

    it('uses the existing custom team rate, not the seat default, as the previous rate', async () => {
      mockFindByStripeSubId.mockResolvedValue({
        id: 'sub-1',
        ownerType: 'Organization',
        ownerId: 'org-1',
        quantity: 3,
        customCreditsPerCycle: 7000,
      });
      mockOrgFindById.mockResolvedValue({ id: 'org-1', name: 'Acme', users: [] });

      const { run } = call({});
      await run();

      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          organizationId: 'org-1',
          changes: [{ field: 'customCreditsPerCycle', before: 7000, after: 5000 }],
          details: expect.objectContaining({ credits: -2000, previousCreditsPerCycle: 7000 }),
        })
      );
    });

    it('records the reason on the audit entry', async () => {
      const { run } = call({ body: { creditsPerCycle: 5000, reason: 'Customer goodwill credit' } });
      await run();

      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ action: 'user.credits.adjusted', reason: 'Customer goodwill credit' })
      );
    });

    it('fails the request without notifying when the audit write fails', async () => {
      mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));

      const { res, run } = call({});
      await expect(run()).rejects.toThrow('audit down');

      expect(mockSendToClient).not.toHaveBeenCalled();
      expect(res._getData()).toBe('');
    });
  });
});
