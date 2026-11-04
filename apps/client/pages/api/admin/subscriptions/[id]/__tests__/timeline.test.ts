import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { Types } from 'mongoose';

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: (config?: unknown) => {
    const handlers: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const guards: Array<(req: unknown, res: unknown, next: () => void) => void> = [];
    const chain = Object.assign(
      (req: { method?: string }, res: unknown) => {
        for (const guard of guards) guard(req, res, () => {});
        return handlers[req.method ?? 'GET']?.(req, res);
      },
      {
        use: (fn: (req: unknown, res: unknown, next: () => void) => void) => (guards.push(fn), chain),
        get: (fn: (req: unknown, res: unknown) => unknown) => ((handlers.GET = fn), chain),
        _config: config,
      }
    );
    return chain;
  },
}));
vi.mock('@server/middlewares/asyncHandler', () => ({ asyncHandler: (fn: unknown) => fn }));

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  listBilling: vi.fn(),
  listAdmin: vi.fn(),
  findCredits: vi.fn(),
  creditRows: [] as unknown[],
}));

vi.mock('@bike4mind/server-utils/models/Subscription', () => ({
  subscriptionRepository: { findById: mocks.findById },
}));
vi.mock('@bike4mind/database', () => {
  const query = { sort: () => query, limit: () => query, maxTimeMS: () => query, lean: async () => mocks.creditRows };
  return {
    CREDIT_BALANCE_EVENT_TYPES: ['purchase', 'subscription', 'generic_add', 'generic_deduct'],
    billingEventRepository: { listForSubscription: mocks.listBilling },
    adminAuditLogRepository: { listForSubscriptionOrOwner: mocks.listAdmin },
    CreditTransaction: {
      find: (filter: unknown) => {
        mocks.findCredits(filter);
        return query;
      },
    },
  };
});

import { encodeAuditCursor } from '@server/utils/adminAuditQuery';
import handler from '../timeline';

const ADMIN = { id: 'a'.repeat(24), isAdmin: true };
const ID = 'b'.repeat(24);
type Handler = (req: unknown, res: unknown) => Promise<unknown>;

async function call(query: Record<string, string> = {}, user: Record<string, unknown> = ADMIN, id = ID) {
  const { req, res } = createMocks({ method: 'GET', query: { id, ...query } });
  Object.assign(req, { user });
  await (handler as unknown as Handler)(req, res);
  return res;
}

const objectId = (hexDigit: string) => hexDigit.repeat(24);
const day = (n: number) => new Date(Date.UTC(2026, 9, n));

const billingRecord = {
  id: objectId('1'),
  stripeEventId: 'evt_1',
  type: 'invoice.payment_failed',
  ownerType: 'user',
  ownerId: 'u1',
  subscriptionId: 'sub_1',
  amount: 1900,
  currency: 'usd',
  occurredAt: day(3),
  data: { attemptCount: 1, dunningNoticeSent: true },
};

const auditEntry = {
  id: objectId('2'),
  occurredAt: day(2),
  action: 'billing.comp.changed',
  summary: 'Extended the comp',
  actor: { kind: 'user', scope: 'platform', userId: 'admin-1', name: 'Admin', wasAdmin: true },
};

const creditRow = {
  _id: new Types.ObjectId(objectId('3')),
  type: 'subscription',
  credits: 5000,
  createdAt: day(4),
};

describe('GET /api/admin/subscriptions/[id]/timeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findById.mockResolvedValue({ id: ID, ownerType: 'User', ownerId: 'u1', subscriptionId: 'sub_1' });
    mocks.listBilling.mockResolvedValue({ records: [billingRecord], hasMore: false });
    mocks.listAdmin.mockResolvedValue({ entries: [auditEntry], nextCursor: null });
    mocks.creditRows = [creditRow];
  });

  it('requires JWT auth and allows only GET', () => {
    expect((handler as unknown as { _config: unknown })._config).toEqual({
      auth: 'jwtOnly',
      allowedMethods: ['GET'],
    });
  });

  it('admits a delegated admin holding support:read', async () => {
    const res = await call({}, { id: ADMIN.id, isAdmin: false, adminPermissions: ['support:read'] });
    expect(res._getStatusCode()).toBe(200);
  });

  it('refuses a non-admin before reading anything', async () => {
    await expect(call({}, { ...ADMIN, isAdmin: false })).rejects.toThrow('Missing permission: support:read');
    expect(mocks.findById).not.toHaveBeenCalled();
    expect(mocks.listBilling).not.toHaveBeenCalled();
  });

  it('404s for a missing subscription or a malformed id', async () => {
    mocks.findById.mockResolvedValue(null);
    await expect(call()).rejects.toMatchObject({ statusCode: 404 });
    await expect(call({}, ADMIN, 'nope')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('merges every source newest first, with a summary on each item', async () => {
    const res = await call();

    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
    const { items, nextCursor } = res._getJSONData();
    expect(items.map((item: { kind: string }) => item.kind)).toEqual(['credit', 'billing', 'admin']);
    expect(items.map((item: { summary: string }) => item.summary)).toEqual([
      'Plan credits granted: +5,000 credits',
      'Payment failed (attempt 1), dunning email sent',
      'Extended the comp',
    ]);
    expect(items[1]).toMatchObject({ amount: 1900, currency: 'usd', stripeEventId: 'evt_1' });
    expect(nextCursor).toBeNull();
  });

  it('scopes each source to the subscription and its owner', async () => {
    await call();

    expect(mocks.listBilling).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_1', owner: { ownerType: 'user', ownerId: 'u1' } }),
      { limit: 100, cursor: undefined }
    );
    expect(mocks.listAdmin).toHaveBeenCalledWith(
      { owner: { kind: 'user', id: 'u1' }, subscriptionIds: ['sub_1', ID] },
      { limit: 100, cursor: undefined }
    );
    expect(JSON.stringify(mocks.findCredits.mock.calls[0][0])).toContain('"ownerId":"u1"');
  });

  it('reads only the source a kind filter names', async () => {
    const res = await call({ kind: 'billing' });

    expect(res._getJSONData().items.map((item: { kind: string }) => item.kind)).toEqual(['billing']);
    expect(mocks.listAdmin).not.toHaveBeenCalled();
    expect(mocks.findCredits).not.toHaveBeenCalled();
  });

  it('asks a comp for no owner-level Stripe events', async () => {
    mocks.findById.mockResolvedValue({ id: ID, ownerType: 'User', ownerId: 'u1', subscriptionId: 'admin_grant_x' });
    await call({ kind: 'billing' });
    expect(mocks.listBilling.mock.calls[0][0]).toEqual({ subscriptionId: 'admin_grant_x' });
  });

  it('pages: caps at the limit and hands back the last item as the cursor', async () => {
    const res = await call({ limit: '2' });

    const { items, nextCursor } = res._getJSONData();
    expect(items).toHaveLength(2);
    expect(nextCursor).toBe(encodeAuditCursor({ occurredAt: day(3), id: objectId('1') }));

    await call({ cursor: nextCursor });
    expect(mocks.listBilling.mock.calls[1][1].cursor).toEqual({ occurredAt: day(3), id: objectId('1') });
  });

  it('400s on a bad kind, limit or cursor', async () => {
    await expect(call({ kind: 'nope' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ limit: '501' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ limit: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(call({ cursor: '%%%' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
