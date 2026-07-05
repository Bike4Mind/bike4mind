import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindOneAndUpdate, mockReportUpdateMany } = vi.hoisted(() => ({
  mockFindOneAndUpdate: vi.fn(),
  mockReportUpdateMany: vi.fn(),
}));

// baseApi mock: callable chain routed by req.method; .use() no-op; last fn per verb is the handler.
vi.mock('@server/middlewares/baseApi', () => ({
  baseApi: () => {
    const h: Record<string, (req: unknown, res: unknown) => unknown> = {};
    const chain = Object.assign(
      (req: unknown, res: unknown) => h[(req as { method?: string }).method ?? 'GET']?.(req, res),
      {
        use: () => chain,
        post: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.POST = fns[fns.length - 1]), chain),
        delete: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.DELETE = fns[fns.length - 1]), chain),
      }
    );
    return chain;
  },
}));

// ForbiddenError: a throwable the handler propagates; we assert it's thrown (the real
// baseApi error middleware maps it to 403, out of scope for a unit test).
vi.mock('@server/utils/errors', () => ({
  ForbiddenError: class ForbiddenError extends Error {},
}));

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    findOneAndUpdate: (...a: unknown[]) => mockFindOneAndUpdate(...a),
  },
  PublishedArtifactReport: {
    updateMany: (...a: unknown[]) => Promise.resolve(mockReportUpdateMany(...a)),
  },
}));

// Stub the publish service so this test stays focused on takedown logic (the real
// module pulls in AWS/SST). CDN invalidation is covered by invalidatePublishCdn.test.ts.
const invalidateMock = vi.hoisted(() => vi.fn());
vi.mock('@server/services/publish', () => ({
  invalidatePublishCdn: invalidateMock,
  toCacheTarget: (a: unknown) => a,
}));

import handler from '../takedown';

type RunOpts = { method: 'POST' | 'DELETE'; user?: unknown; id?: string; body?: unknown };
const run = ({ method, user, id = 'pub1', body = {} }: RunOpts) => {
  const { req, res } = createMocks({ method, query: { id }, body: body as Record<string, unknown> });
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn() };
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

/** The lean-ish doc findOneAndUpdate resolves to (new:true). */
function updatedDoc(over: Record<string, unknown> = {}) {
  return { publicId: 'pub1', tier: 'user', scopeId: 'u1', slug: 'r-pub1', source: { kind: 'reply' }, ...over };
}

const ADMIN = { id: 'admin1', isAdmin: true };

beforeEach(() => {
  mockFindOneAndUpdate.mockReset();
  mockReportUpdateMany.mockReset().mockResolvedValue({});
  invalidateMock.mockReset();
});

describe('POST /api/admin/published-artifacts/:id/takedown', () => {
  it('rejects non-admins', async () => {
    const { promise } = run({ method: 'POST', user: { id: 'u1', isAdmin: false } });
    await expect(promise).rejects.toThrow();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('takes a page down atomically, resolves reports, and purges the CDN', async () => {
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc());
    const { res, promise } = run({ method: 'POST', user: ADMIN, body: { reason: 'phishing host' } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    // Atomic update on the live row, not load-then-save.
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ publicId: 'pub1', deletedAt: null });
    expect(update.$set).toMatchObject({
      moderationStatus: 'taken_down',
      takedownReason: 'phishing host',
      deletedBy: 'admin1',
    });
    expect(update.$set.deletedAt).toBeInstanceOf(Date);
    expect(mockReportUpdateMany).toHaveBeenCalledWith(
      { publicId: 'pub1', status: 'open' },
      expect.objectContaining({ $set: expect.objectContaining({ status: 'actioned', resolvedBy: 'admin1' }) })
    );
    expect(invalidateMock).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'pub1' }), expect.anything());
  });

  it('404s when the page is missing or already taken down', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    const { res, promise } = run({ method: 'POST', user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(404);
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/admin/published-artifacts/:id/takedown — restore', () => {
  it('rejects non-admins', async () => {
    const { promise } = run({ method: 'DELETE', user: { id: 'u1', isAdmin: false } });
    await expect(promise).rejects.toThrow();
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('restores a taken-down page back to active and purges the cached 404', async () => {
    mockFindOneAndUpdate.mockResolvedValue(updatedDoc());
    const { res, promise } = run({ method: 'DELETE', user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ publicId: 'pub1', moderationStatus: 'taken_down' });
    expect(update.$set).toMatchObject({ moderationStatus: 'active', takedownReason: null, deletedAt: null });
    expect(invalidateMock).toHaveBeenCalledWith(expect.objectContaining({ publicId: 'pub1' }), expect.anything());
  });

  it('404s when there is no taken-down page with that id', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null);
    const { res, promise } = run({ method: 'DELETE', user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('409s when restore collides with a slug re-published while down (E11000)', async () => {
    mockFindOneAndUpdate.mockRejectedValue(Object.assign(new Error('dup key'), { code: 11000 }));
    const { res, promise } = run({ method: 'DELETE', user: ADMIN });
    await promise;
    expect(res._getStatusCode()).toBe(409);
    expect(invalidateMock).not.toHaveBeenCalled();
  });
});
