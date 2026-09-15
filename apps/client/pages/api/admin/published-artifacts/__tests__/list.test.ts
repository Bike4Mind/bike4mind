import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFind, mockCount } = vi.hoisted(() => ({
  mockFind: vi.fn(),
  mockCount: vi.fn(),
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

vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

// find() returns a chainable query terminating in lean(); capture the filter it was called with.
vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    find: (...a: unknown[]) => {
      mockFind(...a);
      const q = {
        select: () => q,
        sort: () => q,
        skip: () => q,
        limit: () => q,
        lean: () => Promise.resolve([]),
      };
      return q;
    },
    countDocuments: (...a: unknown[]) => Promise.resolve(mockCount(...a)),
  },
}));

import handler from '../index';

type RunOpts = { user?: unknown; status?: string };
const run = ({ user, status }: RunOpts = {}) => {
  const query: Record<string, unknown> = {};
  if (status) query.status = status;
  const { req, res } = createMocks({ method: 'GET', query });
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

const ADMIN = { id: 'admin1', isAdmin: true };

beforeEach(() => {
  mockFind.mockReset();
  mockCount.mockReset().mockResolvedValue(0);
});

describe('GET /api/admin/published-artifacts', () => {
  it('rejects non-admins', async () => {
    const { promise } = run({ user: { id: 'u1', isAdmin: false } });
    await expect(promise).rejects.toThrow();
    expect(mockFind).not.toHaveBeenCalled();
  });

  it('defaults to the reported, non-deleted queue', async () => {
    const { res, promise } = run({ user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockFind).toHaveBeenCalledWith({ moderationStatus: 'reported', deletedAt: null });
  });

  it('taken_down filter includes soft-deleted rows (no deletedAt:null constraint)', async () => {
    const { promise } = run({ user: ADMIN, status: 'taken_down' });
    await promise;
    expect(mockFind).toHaveBeenCalledWith({ moderationStatus: 'taken_down' });
  });

  it('all filter applies no constraint', async () => {
    const { promise } = run({ user: ADMIN, status: 'all' });
    await promise;
    expect(mockFind).toHaveBeenCalledWith({});
  });

  it('rejects an unknown status filter with 400', async () => {
    const { res, promise } = run({ user: ADMIN, status: 'bogus' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockFind).not.toHaveBeenCalled();
  });
});
