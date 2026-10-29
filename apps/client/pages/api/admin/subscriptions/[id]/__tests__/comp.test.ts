import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { ApiKeyScope } from '@bike4mind/common';
import { COMP_MAX_MONTHS_AHEAD } from '@client/app/utils/adminSubscriptionDetail';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: { method?: string }, res: unknown) => handlers[req.method ?? 'POST']?.(req, res),
      {
        post: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.POST = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

let inTransaction = false;
let insideTransactionAtAudit: boolean | undefined;
const mockUserFindById = vi.fn();
const mockOrgFindById = vi.fn();
vi.mock('@bike4mind/database', () => ({
  userRepository: { findById: (...a: unknown[]) => mockUserFindById(...a) },
  organizationRepository: { findById: (...a: unknown[]) => mockOrgFindById(...a) },
  withTransaction: async (fn: () => Promise<unknown>) => {
    inTransaction = true;
    try {
      return await fn();
    } finally {
      inTransaction = false;
    }
  },
}));

const mockFindById = vi.fn();
const mockUpdate = vi.fn();
const mockFindNonTerminal = vi.fn();
const mockModelFindById = vi.fn();
vi.mock('@server/models/Subscription', () => ({
  subscriptionRepository: {
    findById: (...a: unknown[]) => mockFindById(...a),
    findNonTerminalSubscriptionsByOwner: (...a: unknown[]) => mockFindNonTerminal(...a),
  },
  Subscription: {
    findById: (...a: unknown[]) => ({ lean: () => mockModelFindById(...a) }),
    findOneAndUpdate: (...a: unknown[]) => ({ lean: () => mockUpdate(...a) }),
  },
}));

const mockToRows = vi.fn();
vi.mock('@server/admin/subscriptionsList/listAdminSubscriptions', () => ({
  toAdminSubscriptionRows: (...a: unknown[]) => mockToRows(...a),
}));
vi.mock('@server/admin/subscriptionsList/adminSubscriptionsQuery', () => ({ subscriptionPlanCatalog: () => ({}) }));

const mockRecordAdminAction = vi.fn();
vi.mock('@server/utils/adminAudit', async importOriginal => {
  const actual = await importOriginal<typeof import('@server/utils/adminAudit')>();
  const { ForbiddenError } = await import('@bike4mind/common');
  return {
    ...actual,
    recordAdminActionFromRequest: (...a: unknown[]) => {
      insideTransactionAtAudit = inTransaction;
      return mockRecordAdminAction(...a);
    },
    denySelfAdminAction: async (req: unknown, { action, attempted, target }: Record<string, unknown>) => {
      await mockRecordAdminAction(req, { action, target, details: { attemptedAction: attempted } });
      throw new ForbiddenError('Admins cannot perform this action on their own account.');
    },
  };
});

const mockSendToClient = vi.fn();
vi.mock('@server/websocket/utils', () => ({ sendToClient: (...a: unknown[]) => mockSendToClient(...a) }));
vi.mock('sst', () => ({ Resource: { websocket: { managementEndpoint: 'ws-endpoint' } } }));

import { ADMIN_ACTION_REASON_MISSING_MESSAGE } from '@server/utils/adminAudit';
import handler from '../comp';

const ID = 'b'.repeat(24);
const REASON = 'Partner extension agreed';
const DAY = 86_400_000;
const CURRENT_END = new Date(Date.now() + 30 * DAY);

const compRow = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  ownerType: 'User',
  ownerId: 'u1',
  subscriptionId: 'admin_grant_1',
  source: 'admin_grant',
  priceId: 'price_a',
  status: 'active',
  periodEndsAt: CURRENT_END,
  ...overrides,
});

function call(options: { isAdmin?: boolean; body?: Record<string, unknown>; id?: string; adminId?: string } = {}) {
  const { req, res } = createMocks({
    method: 'POST',
    query: { id: options.id ?? ID },
    body: { reason: REASON, ...(options.body ?? { action: 'end' }) },
  });
  Object.assign(req, {
    user: { isAdmin: options.isAdmin ?? true, id: options.adminId ?? 'admin-1' },
    logger: { info: vi.fn() },
  });
  return { res, run: () => (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res) };
}

const isoIn = (days: number) => new Date(Date.now() + days * DAY).toISOString();

const guardFor = (status: string, extra: Record<string, unknown> = {}) => ({
  _id: ID,
  source: 'admin_grant',
  subscriptionId: 'admin_grant_1',
  status,
  ...extra,
});

describe('POST /api/admin/subscriptions/[id]/comp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    insideTransactionAtAudit = undefined;
    mockFindById.mockResolvedValue(compRow());
    mockUserFindById.mockResolvedValue({ id: 'u1', email: 'u1@example.com' });
    mockOrgFindById.mockResolvedValue({ id: 'o1', name: 'Acme', userId: 'boss-1' });
    mockFindNonTerminal.mockResolvedValue([]);
    mockUpdate.mockResolvedValue({ _id: ID });
    mockRecordAdminAction.mockResolvedValue(null);
    mockModelFindById.mockResolvedValue({ _id: ID });
    mockToRows.mockResolvedValue([{ id: ID, status: 'canceled' }]);
  });

  it('requires JWT auth with admin scope', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      requiredScopes: [ApiKeyScope.ADMIN],
    });
  });

  it('refuses a non-admin', async () => {
    await expect(call({ isAdmin: false }).run()).rejects.toThrow('Admin access required');
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  it('400s without a reason and changes nothing', async () => {
    const { req, res } = createMocks({ method: 'POST', query: { id: ID }, body: { action: 'end' } });
    Object.assign(req, { user: { isAdmin: true, id: 'admin-1' } });
    await expect(
      (handler as unknown as (rq: unknown, rs: unknown) => Promise<unknown>)(req, res)
    ).rejects.toMatchObject({
      statusCode: 400,
      message: ADMIN_ACTION_REASON_MISSING_MESSAGE,
    });
    expect(mockUpdate).not.toHaveBeenCalled();
    expect(mockRecordAdminAction).not.toHaveBeenCalled();
  });

  it('400s on an unknown action', async () => {
    await expect(call({ body: { action: 'delete' } }).run()).rejects.toMatchObject({ statusCode: 400 });
  });

  it('404s for a missing subscription or a malformed id', async () => {
    mockFindById.mockResolvedValue(null);
    await expect(call().run()).rejects.toMatchObject({ statusCode: 404 });
    await expect(call({ id: 'nope' }).run()).rejects.toMatchObject({ statusCode: 404 });
  });

  it('409s for a row that is not a comp', async () => {
    mockFindById.mockResolvedValue(compRow({ source: 'stripe', subscriptionId: 'sub_123' }));
    await expect(call().run()).rejects.toMatchObject({
      statusCode: 409,
      message: 'Only comped subscriptions can be changed here.',
    });
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  describe('self-target guard', () => {
    it('403s and records a denied entry when the admin owns the comp', async () => {
      await expect(call({ adminId: 'u1' }).run()).rejects.toMatchObject({ statusCode: 403 });
      expect(mockUpdate).not.toHaveBeenCalled();
      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'user.subscription.denied',
          details: { attemptedAction: 'billing.comp.changed' },
        })
      );
    });

    it('403s when the admin owns the comped organization', async () => {
      mockFindById.mockResolvedValue(compRow({ ownerType: 'Organization', ownerId: 'o1' }));
      await expect(call({ adminId: 'boss-1' }).run()).rejects.toMatchObject({ statusCode: 403 });
      expect(mockUpdate).not.toHaveBeenCalled();
    });
  });

  describe('setEndsAt', () => {
    it('extends the comp and audits the before/after inside the transaction', async () => {
      const periodEndsAt = isoIn(90);
      const { res, run } = call({ body: { action: 'setEndsAt', periodEndsAt } });
      await run();

      expect(mockUpdate).toHaveBeenCalledWith(
        guardFor('active', { periodEndsAt: CURRENT_END }),
        { $set: { periodEndsAt: new Date(periodEndsAt) } },
        { new: true }
      );
      expect(insideTransactionAtAudit).toBe(true);
      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          action: 'billing.comp.changed',
          target: { kind: 'user', id: 'u1', displayName: 'u1@example.com' },
          summary: `extended comp to ${periodEndsAt.slice(0, 10)}`,
          reason: REASON,
          changes: [{ field: 'periodEndsAt', before: CURRENT_END.toISOString(), after: periodEndsAt }],
          details: { subscriptionId: 'admin_grant_1', subscriptionRecordId: ID, change: 'setEndsAt' },
        })
      );
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData()).toEqual({ subscription: { id: ID, status: 'canceled' } });
    });

    it('words an earlier date as a move', async () => {
      const periodEndsAt = isoIn(5);
      await call({ body: { action: 'setEndsAt', periodEndsAt } }).run();
      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ summary: `moved comp end date to ${periodEndsAt.slice(0, 10)}` })
      );
    });

    // Undoing an extend on a comp that had already lapsed restores a past end date.
    it('allows a past date', async () => {
      const { res, run } = call({ body: { action: 'setEndsAt', periodEndsAt: isoIn(-5) } });
      await run();
      expect(res._getStatusCode()).toBe(200);
    });

    it('409s and writes no audit when the row changed after it was read', async () => {
      mockUpdate.mockResolvedValue(null);
      await expect(call({ body: { action: 'setEndsAt', periodEndsAt: isoIn(90) } }).run()).rejects.toMatchObject({
        statusCode: 409,
        message: 'This subscription changed; reload and try again.',
      });
      expect(mockRecordAdminAction).not.toHaveBeenCalled();
      expect(mockSendToClient).not.toHaveBeenCalled();
    });

    it('400s past the maximum horizon', async () => {
      const far = new Date();
      far.setUTCMonth(far.getUTCMonth() + COMP_MAX_MONTHS_AHEAD + 1);
      await expect(
        call({ body: { action: 'setEndsAt', periodEndsAt: far.toISOString() } }).run()
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('400s when the date is unchanged', async () => {
      await expect(
        call({ body: { action: 'setEndsAt', periodEndsAt: CURRENT_END.toISOString() } }).run()
      ).rejects.toMatchObject({ statusCode: 400 });
    });

    it('409s on an ended comp', async () => {
      mockFindById.mockResolvedValue(compRow({ status: 'canceled' }));
      await expect(call({ body: { action: 'setEndsAt', periodEndsAt: isoIn(90) } }).run()).rejects.toMatchObject({
        statusCode: 409,
      });
    });
  });

  describe('end', () => {
    it('cancels the comp and audits the status change, tagging an organization owner', async () => {
      mockFindById.mockResolvedValue(compRow({ ownerType: 'Organization', ownerId: 'o1' }));
      await call({ body: { action: 'end' } }).run();

      expect(mockUpdate).toHaveBeenCalledWith(
        guardFor('active'),
        { $set: { status: 'canceled', canceledAt: expect.any(Date) } },
        { new: true }
      );
      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          summary: 'ended comp',
          target: { kind: 'organization', id: 'o1', displayName: 'Acme' },
          organizationId: 'o1',
          changes: [{ field: 'status', before: 'active', after: 'canceled' }],
          details: expect.objectContaining({ change: 'end' }),
        })
      );
    });

    it('invalidates the owner and the admin user-subscriptions query after commit', async () => {
      await call({ body: { action: 'end' } }).run();
      expect(mockSendToClient).toHaveBeenCalledWith('u1', 'ws-endpoint', {
        action: 'invalidate_query',
        queryKey: ['subscriptions'],
      });
      expect(mockSendToClient).toHaveBeenCalledWith('u1', 'ws-endpoint', {
        action: 'invalidate_query',
        queryKey: ['admin', 'user-subscriptions', 'u1'],
      });
    });

    it('409s on a comp that already ended', async () => {
      mockFindById.mockResolvedValue(compRow({ status: 'canceled' }));
      await expect(call({ body: { action: 'end' } }).run()).rejects.toMatchObject({ statusCode: 409 });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('rolls nothing out when the strict audit fails', async () => {
      mockRecordAdminAction.mockRejectedValueOnce(new Error('audit down'));
      await expect(call({ body: { action: 'end' } }).run()).rejects.toThrow('audit down');
      expect(mockSendToClient).not.toHaveBeenCalled();
    });
  });

  describe('reopen', () => {
    beforeEach(() => {
      mockFindById.mockResolvedValue(compRow({ status: 'canceled' }));
    });

    it('reactivates an ended comp and clears canceledAt', async () => {
      await call({ body: { action: 'reopen' } }).run();
      expect(mockUpdate).toHaveBeenCalledWith(
        guardFor('canceled'),
        { $set: { status: 'active', canceledAt: null } },
        { new: true }
      );
      expect(mockRecordAdminAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          summary: 'reopened comp',
          changes: [{ field: 'status', before: 'canceled', after: 'active' }],
        })
      );
    });

    it('409s when the comp has not ended', async () => {
      mockFindById.mockResolvedValue(compRow({ status: 'active' }));
      await expect(call({ body: { action: 'reopen' } }).run()).rejects.toMatchObject({ statusCode: 409 });
    });

    it('409s when the owner already has another live comp', async () => {
      mockFindNonTerminal.mockResolvedValue([
        {
          id: 'c'.repeat(24),
          source: 'admin_grant',
          subscriptionId: 'admin_grant_2',
          status: 'active',
          priceId: 'price_b',
        },
      ]);
      await expect(call({ body: { action: 'reopen' } }).run()).rejects.toMatchObject({ statusCode: 409 });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('409s when a user already has an active row on the same plan', async () => {
      mockFindNonTerminal.mockResolvedValue([
        { id: 'c'.repeat(24), source: 'stripe', subscriptionId: 'sub_9', status: 'active', priceId: 'price_a' },
      ]);
      await expect(call({ body: { action: 'reopen' } }).run()).rejects.toMatchObject({ statusCode: 409 });
    });

    it('409s when an organization already has an active row on the same plan', async () => {
      mockFindById.mockResolvedValue(compRow({ status: 'canceled', ownerType: 'Organization', ownerId: 'o1' }));
      mockFindNonTerminal.mockResolvedValue([
        { id: 'c'.repeat(24), source: 'stripe', subscriptionId: 'sub_9', status: 'active', priceId: 'price_a' },
      ]);
      await expect(call({ body: { action: 'reopen' } }).run()).rejects.toMatchObject({
        statusCode: 409,
        message: 'This owner already has an active subscription on the same plan.',
      });
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('allows a different live plan beside the reopened comp', async () => {
      mockFindNonTerminal.mockResolvedValue([
        { id: 'c'.repeat(24), source: 'stripe', subscriptionId: 'sub_9', status: 'active', priceId: 'price_other' },
      ]);
      await call({ body: { action: 'reopen' } }).run();
      expect(mockUpdate).toHaveBeenCalled();
    });
  });
});
