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
        get: (...fns: ((req: unknown, res: unknown) => unknown)[]) => ((h.GET = fns[fns.length - 1]), chain),
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

type RunOpts = { method?: 'GET' | 'POST' | 'DELETE'; user?: unknown; publicId?: string; body?: unknown };
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

  // On a NON-public artifact the token is the gate's only enforcing surface: revoking it
  // would strand a gate nothing honors - the same state PATCH refuses to create.
  it('refuses to revoke while a gate on a private artifact has no other enforcing surface', async () => {
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareToken: 'EXISTING',
      visibility: 'private',
      accessGate: { kind: 'passphrase', passphraseHash: 'x' },
    });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().code).toBe('REVOKE_WOULD_ORPHAN_GATE');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('allows the revoke when the artifact is public - visibility still enforces the gate', async () => {
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareToken: 'EXISTING',
      visibility: 'public',
      accessGate: { kind: 'passphrase', passphraseHash: 'x' },
    });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalled();
  });

  it('allows the revoke on an ungated private artifact', async () => {
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareToken: 'EXISTING',
      visibility: 'private',
      accessGate: null,
    });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalled();
  });
});

describe('GET /api/publish/[publicId]/share-token', () => {
  it('reports a live link without minting one', async () => {
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareToken: 'EXISTING',
      shareTokenUpdatedAt: new Date('2026-09-14T00:00:00.000Z'),
    });
    const { res, promise } = run({ method: 'GET' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      hasShareToken: true,
      shareToken: 'EXISTING',
      shareUrl: '/a/EXISTING',
      shareTokenUpdatedAt: '2026-09-14T00:00:00.000Z',
    });
    // Soft-deleted artifacts must stay invisible to the read, same as POST/DELETE.
    expect(mockLoad.mock.calls[0][0]).toEqual({ publicId: 'pub1', deletedAt: null });
    // The whole point of the route: looking must never create a link.
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('reports no link when none has been minted', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1' });
    const { res, promise } = run({ method: 'GET' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      hasShareToken: false,
      shareToken: null,
      shareUrl: null,
      shareTokenUpdatedAt: null,
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller', async () => {
    const { res, promise } = run({ method: 'GET', user: null });
    await promise;
    expect(res._getStatusCode()).toBe(401);
  });

  it('403s a non-owner, non-admin - the token is never disclosed', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareToken: 'EXISTING' });
    const { res, promise } = run({ method: 'GET', user: { id: 'intruder' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
    expect(JSON.stringify(res._getJSONData())).not.toContain('EXISTING');
  });

  it('404s when the artifact does not exist', async () => {
    mockLoad.mockResolvedValue(null);
    const { res, promise } = run({ method: 'GET' });
    await promise;
    expect(res._getStatusCode()).toBe(404);
  });

  it('400s a missing publicId without touching the database', async () => {
    const { res, promise } = run({ method: 'GET', publicId: '' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockLoad).not.toHaveBeenCalled();
  });

  // The body carries the capability token, so a shared cache must never hold it. The
  // header is set before the gate, so it covers the error bodies too.
  it.each([
    ['a live link', { publicId: 'pub1', ownerId: 'owner1', shareToken: 'EXISTING' }, { id: 'owner1' }, 200],
    ['a 403', { publicId: 'pub1', ownerId: 'owner1' }, { id: 'intruder' }, 403],
  ])('sends private, no-store on %s', async (_label, artifact, user, status) => {
    mockLoad.mockResolvedValue(artifact);
    const { res, promise } = run({ method: 'GET', user });
    await promise;
    expect(res._getStatusCode()).toBe(status);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
});
