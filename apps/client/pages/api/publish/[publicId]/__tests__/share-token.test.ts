import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';

const { mockFindOne, mockUpdateOne } = vi.hoisted(() => ({
  mockFindOne: vi.fn(),
  mockUpdateOne: vi.fn(),
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
    findOne: (...a: unknown[]) => ({ lean: () => Promise.resolve(mockFindOne(...a)) }),
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
  mockFindOne.mockReset().mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1' });
  mockUpdateOne.mockReset().mockResolvedValue({});
});

describe('POST /api/publish/[publicId]/share-token', () => {
  it('401s an unauthenticated caller', async () => {
    // null (not undefined) so the run() destructuring default does not re-add a user.
    const { res, promise } = run({ user: null });
    await promise;
    expect(res._getStatusCode()).toBe(401);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('403s a non-owner, non-admin', async () => {
    const { res, promise } = run({ user: { id: 'someone-else' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('404s when the artifact does not exist', async () => {
    mockFindOne.mockResolvedValue(null);
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('mints a token when absent and returns the /a URL', async () => {
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ shareToken: 'TESTTOKEN', shareUrl: '/a/TESTTOKEN' });
    expect(mockUpdateOne).toHaveBeenCalledOnce();
    const [, update] = mockUpdateOne.mock.calls[0] as [unknown, { $set: Record<string, unknown> }];
    expect(update.$set.shareToken).toBe('TESTTOKEN');
    expect(update.$set.shareTokenUpdatedAt).toBeInstanceOf(Date);
  });

  it('is idempotent: returns the existing token without rewriting it', async () => {
    mockFindOne.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareToken: 'EXISTING' });
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ shareToken: 'EXISTING', shareUrl: '/a/EXISTING' });
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('rotates the token when regenerate:true, even if one exists', async () => {
    mockFindOne.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareToken: 'EXISTING' });
    const { res, promise } = run({ body: { regenerate: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ shareToken: 'TESTTOKEN', shareUrl: '/a/TESTTOKEN' });
    expect(mockUpdateOne).toHaveBeenCalledOnce();
  });

  it('lets an admin manage a token they do not own', async () => {
    mockFindOne.mockResolvedValue({ publicId: 'pub1', ownerId: 'someone-else' });
    const { res, promise } = run({ user: { id: 'admin1', isAdmin: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
  });
});

describe('DELETE /api/publish/[publicId]/share-token', () => {
  it('revokes the token via $unset', async () => {
    mockFindOne.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareToken: 'EXISTING' });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ revoked: true });
    const [, update] = mockUpdateOne.mock.calls[0] as [unknown, { $unset: Record<string, unknown> }];
    expect(update.$unset).toHaveProperty('shareToken');
  });

  it('is a no-op (still 200) when there is no token to revoke', async () => {
    mockFindOne.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1' });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('403s a non-owner', async () => {
    mockFindOne.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1' });
    const { res, promise } = run({ method: 'DELETE', user: { id: 'intruder' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
  });
});
