import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFind, mockCount } = vi.hoisted(() => ({ mockFind: vi.fn(), mockCount: vi.fn() }));

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

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

// find() returns a chainable query terminating in lean(); capture the filter.
vi.mock('@bike4mind/database', () => ({
  PublishedArtifactReport: {
    find: (...a: unknown[]) => {
      mockFind(...a);
      const q = {
        select: () => q,
        sort: () => q,
        skip: () => q,
        limit: () => q,
        lean: () => Promise.resolve([{ reason: 'phishing', createdAt: '2026-06-25T00:00:00Z' }]),
      };
      return q;
    },
    countDocuments: (...a: unknown[]) => Promise.resolve(mockCount(...a)),
  },
}));

import handler from '../reports';

const run = ({ user, id = 'pub1' }: { user?: unknown; id?: string } = {}) => {
  const { req, res } = createMocks({ method: 'GET', query: { id } });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const ADMIN = { id: 'admin1', isAdmin: true };

beforeEach(() => {
  mockFind.mockReset();
  mockCount.mockReset().mockResolvedValue(1);
});

describe('GET /api/admin/published-artifacts/:id/reports', () => {
  it('rejects non-admins', async () => {
    const { promise } = run({ user: { id: 'u1', isAdmin: false } });
    await expect(promise).rejects.toThrow();
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('returns the reports for the page with pagination metadata', async () => {
    mockCount.mockResolvedValue(1);
    const { res, promise } = run({ user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockFind).toHaveBeenCalledWith({ publicId: 'pub1' });
    const body = res._getJSONData();
    expect(body.reports).toHaveLength(1);
    expect(body).toMatchObject({ total: 1, hasMore: false });
  });

  it('reports hasMore=true when more rows exist beyond this page', async () => {
    mockCount.mockResolvedValue(500);
    const { res, promise } = run({ user: ADMIN });
    await promise;
    expect(res._getJSONData().hasMore).toBe(true);
  });
});
