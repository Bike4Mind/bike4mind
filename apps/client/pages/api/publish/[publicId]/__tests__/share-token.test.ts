import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockLoad, mockFindOneAndUpdate, mockCurrent, mockUpdateOne } = vi.hoisted(() => ({
  mockLoad: vi.fn(), // loadOwnedArtifact's findOne(...).lean()
  mockFindOneAndUpdate: vi.fn(), // the compare-and-set mint/rotate
  mockCurrent: vi.fn(), // lost-race findOne(...).select('shareToken').lean()
  mockUpdateOne: vi.fn(), // DELETE revoke
}));

// baseApi mock: callable chain routed by req.method; supports .post()/.delete().
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

vi.mock('@bike4mind/database', () => ({
  PublishedArtifact: {
    // `.lean()` -> load (loadOwnedArtifact); `.select().lean()` -> lost-race current-token read.
    findOne: (...a: unknown[]) => ({
      select: () => ({ lean: () => Promise.resolve(mockCurrent(...a)) }),
      lean: () => Promise.resolve(mockLoad(...a)),
    }),
    findOneAndUpdate: (...a: unknown[]) => ({ lean: () => Promise.resolve(mockFindOneAndUpdate(...a)) }),
    updateOne: (...a: unknown[]) => Promise.resolve(mockUpdateOne(...a)),
  },
}));

vi.mock('@server/services/publish', () => ({ generateShareToken: () => 'TESTTOKEN' }));

import handler from '../share-token';

type RunOpts = { method?: 'POST' | 'DELETE'; user?: unknown; publicId?: string; body?: unknown };
const run = ({ method = 'POST', user = { id: 'owner1' }, publicId = 'pub1', body = {} }: RunOpts = {}) => {
  const { req, res } = createMocks({ method, query: { publicId }, body: body as Record<string, unknown> });
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn() };
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

beforeEach(() => {
  mockLoad.mockReset().mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1' });
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ shareToken: 'TESTTOKEN' }); // won the CAS
  mockCurrent.mockReset().mockResolvedValue({ shareToken: 'TESTTOKEN' });
  mockUpdateOne.mockReset().mockResolvedValue({});
});

describe('POST /api/publish/[publicId]/share-token', () => {
  it('401s an unauthenticated caller', async () => {
    // null (not undefined) so the run() destructuring default does not re-add a user.
    const { res, promise } = run({ user: null });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('403s a non-owner, non-admin', async () => {
    const { res, promise } = run({ user: { id: 'someone-else' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('404s when the artifact does not exist', async () => {
    mockLoad.mockResolvedValue(null);
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('mints a token when absent via a compare-and-set on token-absent', async () => {
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ shareToken: 'TESTTOKEN', shareUrl: '/a/TESTTOKEN' });
    expect(mockFindOneAndUpdate).toHaveBeenCalledOnce();
    const [filter, update] = mockFindOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> },
    ];
    expect(filter.shareToken).toEqual({ $exists: false }); // precondition: mint only when absent
    expect(update.$set.shareToken).toBe('TESTTOKEN');
    expect(update.$set.shareTokenUpdatedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: returns the existing token without a write', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareToken: 'EXISTING' });
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ shareToken: 'EXISTING', shareUrl: '/a/EXISTING' });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rotates via a compare-and-set pinned to the current token when regenerate:true', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareToken: 'EXISTING' });
    const { res, promise } = run({ body: { regenerate: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ shareToken: 'TESTTOKEN', shareUrl: '/a/TESTTOKEN' });
    const [filter] = mockFindOneAndUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(filter.shareToken).toBe('EXISTING'); // precondition: only rotate if the token is unchanged
  });

  it('on a lost race (CAS matched nothing), returns the concurrently-persisted token', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null); // someone else wrote first
    mockCurrent.mockResolvedValue({ shareToken: 'WINNER-TOKEN' });
    const { res, promise } = run({ body: { regenerate: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ shareToken: 'WINNER-TOKEN', shareUrl: '/a/WINNER-TOKEN' });
  });

  it('lets an admin manage a token they do not own', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'someone-else' });
    const { res, promise } = run({ user: { id: 'admin1', isAdmin: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
  });
});

describe('DELETE /api/publish/[publicId]/share-token', () => {
  it('revokes the token via $unset', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareToken: 'EXISTING' });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ revoked: true });
    const [, update] = mockUpdateOne.mock.calls[0] as [unknown, { $unset: Record<string, unknown> }];
    expect(update.$unset).toHaveProperty('shareToken');
  });

  it('is a no-op (still 200) when there is no token to revoke', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1' });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('403s a non-owner', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1' });
    const { res, promise } = run({ method: 'DELETE', user: { id: 'intruder' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
  });
});
