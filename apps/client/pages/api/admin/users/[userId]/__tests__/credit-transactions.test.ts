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

const run = ({ user, userId = 'u1', days }: { user?: unknown; userId?: string; days?: string } = {}) => {
  const { req, res } = createMocks({ method: 'GET', query: { userId, ...(days ? { days } : {}) } });
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
});
