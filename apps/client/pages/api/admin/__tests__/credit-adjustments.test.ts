import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockQueryPage, mockUserFind } = vi.hoisted(() => ({
  mockQueryPage: vi.fn(),
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
  creditTransactionRepository: { queryAdminAdjustmentsPage: (...a: unknown[]) => mockQueryPage(...a) },
  userRepository: { findById: (...a: unknown[]) => mockUserFind(...a) },
}));

import handler from '../credit-adjustments';

const run = (query: Record<string, string> = {}, user: unknown = { id: 'admin1', isAdmin: true }) => {
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockQueryPage.mockReset().mockResolvedValue({ data: [], total: 0 });
  mockUserFind.mockReset().mockImplementation(async (id: string) => ({ id, name: `Name ${id}` }));
});

describe('GET /api/admin/credit-adjustments', () => {
  it('rejects non-admin callers', async () => {
    const { promise } = run({}, { id: 'u2', isAdmin: false });
    await expect(promise).rejects.toThrow(/Admin access required/);
  });

  it('paginates with defaults (page 1, limit 25, no day window)', async () => {
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockQueryPage).toHaveBeenCalledWith({ days: undefined, limit: 25, skip: 0 });
  });

  it('translates page/limit into skip and forwards the day window', async () => {
    const { promise } = run({ page: '3', limit: '10', days: '30' });
    await promise;
    expect(mockQueryPage).toHaveBeenCalledWith({ days: 30, limit: 10, skip: 20 });
  });

  it('maps rows and resolves both target and actor names', async () => {
    mockQueryPage.mockResolvedValue({
      data: [
        {
          id: 'tx-1',
          type: 'generic_add',
          ownerId: 'user-9',
          credits: 50,
          description: 'Promo bonus',
          reason: 'admin_adjustment',
          createdAt: new Date('2026-07-01T00:00:00Z'),
          metadata: { actorId: 'admin1', resultingBalance: 150 },
        },
      ],
      total: 1,
    });

    const { res, promise } = run();
    await promise;

    const body = res._getJSONData();
    expect(body.total).toBe(1);
    expect(body.totalPages).toBe(1);
    expect(body.rows[0]).toMatchObject({
      id: 'tx-1',
      credits: 50,
      description: 'Promo bonus',
      targetUserId: 'user-9',
      targetUserName: 'Name user-9',
      actorId: 'admin1',
      actorName: 'Name admin1',
      resultingBalance: 150,
    });
  });
});
