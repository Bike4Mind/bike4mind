import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindByOwner, mockUserFind } = vi.hoisted(() => ({
  mockFindByOwner: vi.fn(),
  mockUserFind: vi.fn(),
}));

vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

vi.mock('@server/middlewares/asyncHandler', () => ({
  asyncHandler: (fn: (req: unknown, res: unknown) => unknown) => fn,
}));

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  creditTransactionRepository: { findByOwnerWithFilters: (...a: unknown[]) => mockFindByOwner(...a) },
  userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) },
}));

import handler from '../credit-transactions';

const run = ({
  user,
  userId = 'u1',
  days,
  types,
}: { user?: unknown; userId?: string; days?: string; types?: string } = {}) => {
  const { req, res } = createMocks({
    method: 'GET',
    query: { userId, ...(days ? { days } : {}), ...(types ? { types } : {}) },
  });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const ADMIN = { id: 'admin1', isAdmin: true };

beforeEach(() => {
  mockFindByOwner.mockReset().mockResolvedValue([]);
  mockUserFind.mockReset().mockResolvedValue({ id: 'admin1', name: 'Admin One', email: 'admin@example.com' });
});

describe('GET /api/admin/users/[userId]/credit-transactions', () => {
  it('rejects non-admin callers', async () => {
    const { promise } = run({ user: { id: 'u2', isAdmin: false } });
    await expect(promise).rejects.toThrow(/Admin access required/);
  });

  it('queries only manual-adjustment transaction types for the target user', async () => {
    const { res, promise } = run({ user: ADMIN, userId: 'u1', days: '30' });
    await promise;

    expect(res._getStatusCode()).toBe(200);
    const [ownerId, ownerType, options] = mockFindByOwner.mock.calls[0];
    expect(ownerId).toBe('u1');
    expect(ownerType).toBe('User');
    expect(options.days).toBe(30);
    expect(options.transactionTypes).toEqual(['generic_add', 'generic_deduct']);
  });

  it('maps rows and resolves the actor name from metadata.actorId', async () => {
    mockFindByOwner.mockResolvedValue([
      {
        id: 'tx-1',
        type: 'generic_add',
        credits: 50,
        description: 'Promo bonus',
        reason: 'admin_adjustment',
        createdAt: new Date('2026-07-01T00:00:00Z'),
        metadata: { actorId: 'admin1', resultingBalance: 150 },
      },
    ]);

    const { res, promise } = run({ user: ADMIN });
    await promise;

    expect(mockUserFind).toHaveBeenCalledWith('admin1');
    const { rows } = res._getJSONData();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'tx-1',
      credits: 50,
      description: 'Promo bonus',
      reason: 'admin_adjustment',
      actorId: 'admin1',
      actorName: 'Admin One',
      resultingBalance: 150,
    });
  });

  it('defaults the trailing window to 90 days', async () => {
    const { promise } = run({ user: ADMIN });
    await promise;
    expect(mockFindByOwner.mock.calls[0][2].days).toBe(90);
  });

  it('passes an opt-in types filter through to the repository', async () => {
    const { promise } = run({ user: ADMIN, types: 'purchase,subscription' });
    await promise;
    expect(mockFindByOwner.mock.calls[0][2].transactionTypes).toEqual(['purchase', 'subscription']);
  });

  it('rejects transaction types outside the ledger allowlist', async () => {
    // Usage rows are deliberately not exposed here; they have their own views.
    const { promise } = run({ user: ADMIN, types: 'text_generation_usage' });
    await expect(promise).rejects.toThrow();
    expect(mockFindByOwner).not.toHaveBeenCalled();
  });

  it('surfaces purchase fields so support can verify a payment claim', async () => {
    mockFindByOwner.mockResolvedValue([
      {
        id: 'tx-2',
        type: 'purchase',
        credits: 1000,
        description: 'Credit package',
        createdAt: new Date('2026-07-20T00:00:00Z'),
        status: 'completed',
        stripePaymentIntentId: 'pi_123',
        amount: 10,
        metadata: {},
      },
    ]);

    const { res, promise } = run({ user: ADMIN, types: 'purchase' });
    await promise;

    const { rows } = res._getJSONData();
    expect(rows[0]).toMatchObject({
      id: 'tx-2',
      type: 'purchase',
      credits: 1000,
      status: 'completed',
      stripePaymentIntentId: 'pi_123',
      amount: 10,
    });
    // No actor on a purchase row: nothing to resolve.
    expect(mockUserFind).not.toHaveBeenCalled();
  });

  it('maps subscription rows, which carry no status or amount', async () => {
    mockFindByOwner.mockResolvedValue([
      {
        id: 'tx-3',
        type: 'subscription',
        credits: 500,
        description: 'Monthly plan credits',
        createdAt: new Date('2026-07-21T00:00:00Z'),
        stripePaymentIntentId: 'pi_456',
        metadata: {},
      },
    ]);

    const { res, promise } = run({ user: ADMIN, types: 'subscription' });
    await promise;

    const { rows } = res._getJSONData();
    expect(rows[0]).toMatchObject({ id: 'tx-3', type: 'subscription', credits: 500, stripePaymentIntentId: 'pi_456' });
    expect(rows[0].status).toBeUndefined();
    expect(rows[0].amount).toBeUndefined();
  });

  it('trims whitespace in a hand-typed types list', async () => {
    const { promise } = run({ user: ADMIN, types: 'purchase, subscription' });
    await promise;
    expect(mockFindByOwner.mock.calls[0][2].transactionTypes).toEqual(['purchase', 'subscription']);
  });
});
