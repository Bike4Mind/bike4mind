import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMocks } from 'node-mocks-http';
import { Types } from 'mongoose';

const { mockLoad, mockFindOneAndUpdate, mockCurrent, mockUpdateOne } = vi.hoisted(() => ({
  mockLoad: vi.fn(), // loadOwnedArtifact's findOne(...).lean()
  mockFindOneAndUpdate: vi.fn(), // the compare-and-set mint/rotate/add
  mockCurrent: vi.fn(), // lost-race findOne(...).select(...).lean()
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
    // `.lean()` -> load (loadOwnedArtifact); `.select().lean()` -> lost-race current read.
    findOne: (...a: unknown[]) => ({
      select: () => ({ lean: () => Promise.resolve(mockCurrent(...a)) }),
      lean: () => Promise.resolve(mockLoad(...a)),
    }),
    findOneAndUpdate: (...a: unknown[]) => ({ lean: () => Promise.resolve(mockFindOneAndUpdate(...a)) }),
    updateOne: (...a: unknown[]) => Promise.resolve(mockUpdateOne(...a)),
  },
  // Faithful copy of the model's helper - the real one's behavior (including the legacy-scalar
  // fold-in) is pinned by PublishedArtifactModel.shareToken.test.ts.
  liveShareTokens: (artifact: { shareToken?: string; shareTokens?: { token?: string; revokedAt?: Date | null }[] }) => {
    const live = (artifact.shareTokens ?? []).filter(entry => !!entry?.token && !entry.revokedAt);
    const legacy = artifact.shareToken;
    if (legacy && !live.some(entry => entry.token === legacy)) {
      return [{ token: legacy, revokedAt: null }, ...live];
    }
    return live;
  },
}));

vi.mock('@server/services/publish', () => ({ generateShareToken: () => 'TESTTOKEN' }));

import handler from '../share-token';

type RunOpts = {
  method?: 'GET' | 'POST' | 'DELETE';
  user?: unknown;
  publicId?: string;
  body?: unknown;
  query?: Record<string, string>;
};
const run = ({ method = 'POST', user = { id: 'owner1' }, publicId = 'pub1', body = {}, query = {} }: RunOpts = {}) => {
  const { req, res } = createMocks({
    method,
    query: { publicId, ...query },
    body: body as Record<string, unknown>,
  });
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn() };
  if (user) (req as Record<string, unknown>).user = user;
  return { res, promise: (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res) };
};

/** A `shareTokens[]` entry as the array shape stores it. */
const entry = (token: string, over: Record<string, unknown> = {}) => ({
  _id: new Types.ObjectId(),
  token,
  createdAt: new Date('2026-09-20T00:00:00.000Z'),
  revokedAt: null,
  viewCount: 0,
  lastViewedAt: null,
  ...over,
});

beforeEach(() => {
  mockLoad.mockReset().mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [] });
  mockFindOneAndUpdate.mockReset().mockResolvedValue({ shareTokens: [entry('TESTTOKEN')] }); // won the CAS
  mockCurrent.mockReset().mockResolvedValue({ shareTokens: [entry('TESTTOKEN')] });
  mockUpdateOne.mockReset().mockResolvedValue({});
});

// The pipeline's shareTokens stage, shaped for assertion: $concatArrays is [existing, [new]],
// where `existing` is a raw $map stage on a rotate and the appended entry is a plain object.
interface SharePipelineStage {
  $set: {
    shareToken: string;
    shareTokenUpdatedAt: Date;
    shareTokens: {
      $concatArrays: [
        { $map?: { in: { $cond: unknown[] } } },
        { _id?: unknown; token?: string; revokedAt?: Date | null; viewCount?: number }[],
      ];
    };
  };
}

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

  it('mints a link when none is live, via a compare-and-set on no-live-entry', async () => {
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ shareToken: 'TESTTOKEN', shareUrl: '/a/TESTTOKEN' });
    expect(mockFindOneAndUpdate).toHaveBeenCalledOnce();
    // The update is an aggregation PIPELINE (a one-stage array), not an update document, so the
    // scalar mirror and the shareTokens[] append land in one conflict-free write - see the
    // handler's comment. Hence [0].$set rather than .$set.
    const [filter, pipeline] = mockFindOneAndUpdate.mock.calls[0] as [
      Record<string, unknown>,
      { $set: Record<string, unknown> }[],
    ];
    // #3255 step 3: the ARRAY is the arbiter. "No live entry" is the precondition; the scalar
    // clause only keeps a pre-backfill row from getting a second live link.
    expect(filter.shareTokens).toEqual({ $not: { $elemMatch: { revokedAt: null } } });
    expect(filter.shareToken).toEqual({ $exists: false });
    expect(pipeline[0].$set.shareToken).toBe('TESTTOKEN'); // mirrored, not authoritative
    expect(pipeline[0].$set.shareTokenUpdatedAt).toBeInstanceOf(Date);
  });

  it('appends the minted link to shareTokens[] in the SAME write', async () => {
    // One write, or a crash between two could leave the scalar and the array disagreeing about
    // which links are live.
    const { promise } = run();
    await promise;
    const [, pipeline] = mockFindOneAndUpdate.mock.calls[0] as [unknown, SharePipelineStage[]];
    const appended = pipeline[0].$set.shareTokens.$concatArrays[1][0];
    expect(appended.token).toBe('TESTTOKEN');
    expect(appended.revokedAt).toBeNull();
    expect(appended.viewCount).toBe(0);
    // A pipeline update bypasses Mongoose casting, so the handler must supply the _id itself -
    // without it the entry has no handle for the owner UI to revoke by.
    expect(appended._id).toBeDefined();
  });

  it('returns the new entry id so the caller can revoke the link it just minted', async () => {
    const { res, promise } = run();
    await promise;
    const [, pipeline] = mockFindOneAndUpdate.mock.calls[0] as [unknown, SharePipelineStage[]];
    expect(res._getJSONData().id).toBe(String(pipeline[0].$set.shareTokens.$concatArrays[1][0]._id));
  });

  it('a rotate revokes EVERY live entry in the same write as the append', async () => {
    // `regenerate: true` has always meant "revoke every outstanding link", and #281's Replace
    // button still means that - so with N links it revokes all N, not just the pinned one.
    const live = [entry('OUTGOING-A'), entry('OUTGOING-B')];
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: live });
    const { promise } = run({ body: { regenerate: true } });
    await promise;
    const [, pipeline] = mockFindOneAndUpdate.mock.calls[0] as [unknown, SharePipelineStage[]];
    const [kept, appended] = pipeline[0].$set.shareTokens.$concatArrays;
    // Matched on liveness, not on one token: splitting this into a second write would let a
    // crash leave a rotated-away link live.
    expect(kept.$map?.in.$cond[0]).toEqual({ $eq: [{ $ifNull: ['$$entry.revokedAt', null] }, null] });
    expect(appended[0].token).toBe('TESTTOKEN');
  });

  it('is idempotent: returns the existing link without a write', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [entry('EXISTING')] });
    const { res, promise } = run();
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ shareToken: 'EXISTING', shareUrl: '/a/EXISTING' });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('rotates via a compare-and-set pinned to the outgoing ENTRY when regenerate:true', async () => {
    const outgoing = entry('EXISTING');
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [outgoing] });
    const { res, promise } = run({ body: { regenerate: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ shareToken: 'TESTTOKEN', shareUrl: '/a/TESTTOKEN' });
    const [filter] = mockFindOneAndUpdate.mock.calls[0] as [Record<string, unknown>];
    // Only rotate if that entry is still live - the array, not the scalar, arbitrates.
    expect(filter.shareTokens).toEqual({ $elemMatch: { _id: outgoing._id, revokedAt: null } });
  });

  it('rotates a pre-backfill row by pinning the legacy scalar, which is its only handle', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareToken: 'LEGACY', shareTokens: [] });
    const { res, promise } = run({ body: { regenerate: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const [filter] = mockFindOneAndUpdate.mock.calls[0] as [Record<string, unknown>];
    expect(filter.shareToken).toBe('LEGACY');
  });

  it('on a lost race (CAS matched nothing), returns the concurrently-persisted link', async () => {
    mockFindOneAndUpdate.mockResolvedValue(null); // someone else wrote first
    mockCurrent.mockResolvedValue({ shareTokens: [entry('WINNER-TOKEN')] });
    const { res, promise } = run({ body: { regenerate: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toMatchObject({ shareToken: 'WINNER-TOKEN', shareUrl: '/a/WINNER-TOKEN' });
  });

  it('lets an admin manage a link they do not own', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'someone-else', shareTokens: [] });
    const { res, promise } = run({ user: { id: 'admin1', isAdmin: true } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
  });

  describe('additional: true', () => {
    it('mints a SECOND link alongside a live one, with no liveness precondition', async () => {
      const existing = entry('EXISTING');
      mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [existing] });
      mockFindOneAndUpdate.mockResolvedValue({ shareTokens: [existing, entry('TESTTOKEN')] });
      const { res, promise } = run({ body: { additional: true } });
      await promise;
      expect(res._getStatusCode()).toBe(200);
      expect(res._getJSONData().shareToken).toBe('TESTTOKEN');
      const [filter, pipeline] = mockFindOneAndUpdate.mock.calls[0] as [Record<string, unknown>, SharePipelineStage[]];
      // Adding a link is not idempotent by intent, so no precondition beyond identity.
      expect(filter).toEqual({ publicId: 'pub1', deletedAt: null });
      // Existing entries are carried over untouched - nothing is revoked by adding.
      expect(pipeline[0].$set.shareTokens.$concatArrays[0]).toEqual({ $ifNull: ['$shareTokens', []] });
      expect(res._getJSONData().shareLinks.map((l: { shareToken: string }) => l.shareToken)).toEqual([
        'EXISTING',
        'TESTTOKEN',
      ]);
    });

    it('400s past the live-link ceiling rather than growing the array without bound', async () => {
      const links = Array.from({ length: 20 }, (_, i) => entry(`T${i}`));
      mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: links });
      const { res, promise } = run({ body: { additional: true } });
      await promise;
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().code).toBe('SHARE_LINK_LIMIT');
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });

    it('400s when combined with regenerate, which would revoke what it adds to', async () => {
      const { res, promise } = run({ body: { additional: true, regenerate: true } });
      await promise;
      expect(res._getStatusCode()).toBe(400);
      expect(res._getJSONData().code).toBe('CONFLICTING_MINT_MODE');
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });
});

describe('DELETE /api/publish/[publicId]/share-token', () => {
  /** The revoke pipeline's first stage, which stamps revokedAt on the matched entries. */
  type RevokeStage = { $set: { shareTokens: { $map: { in: { $cond: unknown[] } } } } };

  it('revokes every live link when no id is given', async () => {
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareTokens: [entry('A'), entry('B')],
    });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ revoked: true, remaining: 0 });
    const [, pipeline] = mockUpdateOne.mock.calls[0] as [unknown, RevokeStage[]];
    // Stamped, never pulled: the token must stay claimed in the unique index so a revoked link
    // can never be re-minted, and its view count has to survive.
    expect(pipeline[0].$set.shareTokens.$map.in.$cond[0]).toEqual({
      $and: [{ $eq: [{ $ifNull: ['$$entry.revokedAt', null] }, null] }, { $literal: true }],
    });
  });

  it('revokes ONE link by id and leaves its siblings live', async () => {
    const [a, b] = [entry('A'), entry('B')];
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [a, b] });
    const { res, promise } = run({ method: 'DELETE', query: { id: String(a._id) } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({ revoked: true, remaining: 1 });
    const [, pipeline] = mockUpdateOne.mock.calls[0] as [unknown, RevokeStage[]];
    expect(pipeline[0].$set.shareTokens.$map.in.$cond[0]).toEqual({
      $and: [{ $eq: [{ $ifNull: ['$$entry.revokedAt', null] }, null] }, { $eq: ['$$entry._id', a._id] }],
    });
  });

  it('re-derives the mirrored scalar from the survivors in the same write', async () => {
    // The scalar is no longer authoritative, but it is still read by a rolled-back build, so it
    // must never point at a link this write just revoked.
    const [a, b] = [entry('A'), entry('B')];
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [a, b] });
    const { promise } = run({ method: 'DELETE', query: { id: String(a._id) } });
    await promise;
    const [, pipeline] = mockUpdateOne.mock.calls[0] as [unknown, Record<string, unknown>[]];
    const mirror = pipeline[2] as { $set: { shareToken: unknown } };
    expect(mirror.$set.shareToken).toEqual({ $ifNull: [{ $last: '$__live.token' }, '$$REMOVE'] });
    expect(pipeline[3]).toEqual({ $unset: '__live' }); // the scratch field never persists
  });

  it('404s an id that names no live link, WITHOUT writing', async () => {
    // A pipeline that matched nothing would still rebuild the mirror and, on a pre-backfill
    // row, unset the scalar - an unknown id would revoke the link it did not name.
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [entry('A')] });
    const { res, promise } = run({ method: 'DELETE', query: { id: String(new Types.ObjectId()) } });
    await promise;
    expect(res._getStatusCode()).toBe(404);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('400s a malformed id', async () => {
    const { res, promise } = run({ method: 'DELETE', query: { id: 'not-an-objectid' } });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('is a no-op (still 200) when there is no link to revoke', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [] });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('403s a non-owner', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [] });
    const { res, promise } = run({ method: 'DELETE', user: { id: 'intruder' } });
    await promise;
    expect(res._getStatusCode()).toBe(403);
  });

  // On a NON-public artifact the links are the gate's only enforcing surface: revoking the LAST
  // one would strand a gate nothing honors - the same state PATCH refuses to create.
  it('refuses to revoke the LAST link while a gate on a private artifact needs it', async () => {
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareTokens: [entry('EXISTING')],
      visibility: 'private',
      accessGate: { kind: 'passphrase', passphraseHash: 'x' },
    });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().code).toBe('REVOKE_WOULD_ORPHAN_GATE');
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('allows revoking ONE of several gated links - the survivors still enforce the gate', async () => {
    const [a, b] = [entry('A'), entry('B')];
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareTokens: [a, b],
      visibility: 'private',
      accessGate: { kind: 'passphrase', passphraseHash: 'x' },
    });
    const { res, promise } = run({ method: 'DELETE', query: { id: String(a._id) } });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(mockUpdateOne).toHaveBeenCalled();
  });

  it('still refuses the id-less revoke-all on a gated private artifact with several links', async () => {
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareTokens: [entry('A'), entry('B')],
      visibility: 'private',
      accessGate: { kind: 'passphrase', passphraseHash: 'x' },
    });
    const { res, promise } = run({ method: 'DELETE' });
    await promise;
    expect(res._getStatusCode()).toBe(400);
    expect(res._getJSONData().code).toBe('REVOKE_WOULD_ORPHAN_GATE');
  });

  it('allows the revoke when the artifact is public - visibility still enforces the gate', async () => {
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareTokens: [entry('EXISTING')],
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
      shareTokens: [entry('EXISTING')],
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
  it('lists every live link with its own view count', async () => {
    const [a, b] = [
      entry('A', { viewCount: 7, lastViewedAt: new Date('2026-09-27T00:00:00.000Z') }),
      entry('B', { viewCount: 0 }),
    ];
    mockLoad.mockResolvedValue({
      publicId: 'pub1',
      ownerId: 'owner1',
      shareTokens: [a, b, entry('GONE', { revokedAt: new Date() })],
      shareTokenUpdatedAt: new Date('2026-09-14T00:00:00.000Z'),
    });
    const { res, promise } = run({ method: 'GET' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    const body = res._getJSONData();
    // Revoked entries are not links the owner can use, so the list carries only live ones.
    expect(body.shareLinks).toEqual([
      {
        id: String(a._id),
        shareToken: 'A',
        shareUrl: '/a/A',
        createdAt: '2026-09-20T00:00:00.000Z',
        viewCount: 7,
        lastViewedAt: '2026-09-27T00:00:00.000Z',
      },
      {
        id: String(b._id),
        shareToken: 'B',
        shareUrl: '/a/B',
        createdAt: '2026-09-20T00:00:00.000Z',
        viewCount: 0,
        lastViewedAt: null,
      },
    ]);
    // The single-link fields #281's shipped UI reads describe the NEWEST live link, so that UI
    // keeps working unchanged on deploy.
    expect(body).toMatchObject({ hasShareToken: true, shareToken: 'B', shareUrl: '/a/B' });
    // Soft-deleted artifacts must stay invisible to the read, same as POST/DELETE.
    expect(mockLoad.mock.calls[0][0]).toEqual({ publicId: 'pub1', deletedAt: null });
    // The whole point of the route: looking must never create a link.
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    expect(mockUpdateOne).not.toHaveBeenCalled();
  });

  it('lists a pre-backfill scalar-only link with a null id, so it still renders', async () => {
    // Such a link has no entry handle to revoke by; the id-less DELETE still revokes it.
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareToken: 'LEGACY', shareTokens: [] });
    const { res, promise } = run({ method: 'GET' });
    await promise;
    expect(res._getJSONData().shareLinks).toEqual([
      { id: null, shareToken: 'LEGACY', shareUrl: '/a/LEGACY', createdAt: null, viewCount: 0, lastViewedAt: null },
    ]);
  });

  it('reports no link when none has been minted', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [] });
    const { res, promise } = run({ method: 'GET' });
    await promise;
    expect(res._getStatusCode()).toBe(200);
    expect(res._getJSONData()).toEqual({
      hasShareToken: false,
      shareToken: null,
      shareUrl: null,
      shareTokenUpdatedAt: null,
      shareLinks: [],
    });
    expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
  });

  it('401s an unauthenticated caller', async () => {
    const { res, promise } = run({ method: 'GET', user: null });
    await promise;
    expect(res._getStatusCode()).toBe(401);
  });

  it('403s a non-owner, non-admin - no token is ever disclosed', async () => {
    mockLoad.mockResolvedValue({ publicId: 'pub1', ownerId: 'owner1', shareTokens: [entry('EXISTING')] });
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

  // The body carries the capability tokens, so a shared cache must never hold it. The
  // header is set before the gate, so it covers the error bodies too.
  it.each([
    ['a live link', { publicId: 'pub1', ownerId: 'owner1', shareTokens: [entry('EXISTING')] }, { id: 'owner1' }, 200],
    ['a 403', { publicId: 'pub1', ownerId: 'owner1', shareTokens: [] }, { id: 'intruder' }, 403],
  ])('sends private, no-store on %s', async (_label, artifact, user, status) => {
    mockLoad.mockResolvedValue(artifact);
    const { res, promise } = run({ method: 'GET', user });
    await promise;
    expect(res._getStatusCode()).toBe(status);
    expect(res.getHeader('Cache-Control')).toBe('private, no-store');
  });
});
