import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { createMocks } from 'node-mocks-http';
// createMongoServer is not exported from the package barrel / dist; deep-import the source.
import {
  createMongoServer,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../../../../packages/database/src/__test__/createMongoServer';
import { PublishedArtifact, liveShareTokens, shareTokenFilter } from '@bike4mind/database';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

/**
 * The share-token route against a REAL mongod.
 *
 * Every Mongo call is mocked in `share-token.test.ts`, so the aggregation pipelines there are
 * only asserted structurally - a stage can be shaped exactly as expected and still do the wrong
 * thing to a document. This file drives the same handler against real storage so the SEMANTICS
 * are pinned: `$$REMOVE` really unsets the scalar, `__live` never persists, an entry with no
 * `revokedAt` field counts as live, and the compare-and-set preconditions really do make a
 * racing writer lose. Two defects found in review came from exactly this gap.
 *
 * Only `baseApi` (the middleware chain) and `generateShareToken` (so tokens are predictable)
 * are mocked; the database is real.
 */

let tokenCounter = 0;

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

vi.mock('@server/services/publish', () => ({ generateShareToken: () => `TOK${++tokenCounter}` }));

import handler from '../share-token';

let mongoServer: MongoMemoryServer;

beforeAll(async () => {
  mongoServer = await createMongoServer();
  await mongoose.connect(mongoServer.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});
afterEach(async () => {
  await PublishedArtifact.deleteMany({});
});

type CallOpts = { method?: 'GET' | 'POST' | 'DELETE'; body?: unknown; query?: Record<string, string> };
const call = async ({ method = 'POST', body = {}, query = {} }: CallOpts = {}) => {
  const { req, res } = createMocks({
    method,
    query: { publicId: 'pub1', ...query },
    body: body as Record<string, unknown>,
  });
  (req as Record<string, unknown>).logger = { info: vi.fn(), warn: vi.fn() };
  (req as Record<string, unknown>).user = { id: 'owner1' };
  await (handler as unknown as (req: unknown, res: unknown) => Promise<void>)(req, res);
  return { status: res._getStatusCode(), body: res._getJSONData() };
};

/** The stored document, straight from the driver - no Mongoose transform, so scratch fields and
 *  missing keys are visible exactly as they persist. */
const raw = async () =>
  (await mongoose.connection.db!.collection('published_artifacts').findOne({ publicId: 'pub1' }))!;

const seed = async (over: Record<string, unknown> = {}) => {
  await PublishedArtifact.collection.insertOne({
    publicId: 'pub1',
    ownerId: 'owner1',
    visibility: 'private',
    deletedAt: null,
    shareTokens: [],
    ...over,
  });
};

describe('share-token route against real storage', () => {
  it('mints, adds, revokes by id and revokes the rest, keeping the array and mirror in step', async () => {
    await seed();

    const minted = await call();
    const added = await call({ body: { additional: true } });
    expect(added.status).toBe(200);
    expect(added.body.shareLinks).toHaveLength(2);

    // Both tokens resolve through the shared filter, which is what /a/<token> uses.
    for (const token of [minted.body.shareToken, added.body.shareToken]) {
      expect(await PublishedArtifact.findOne({ deletedAt: null, ...shareTokenFilter(token) })).not.toBeNull();
    }

    const revoked = await call({ method: 'DELETE', query: { id: minted.body.id } });
    expect(revoked.body).toEqual({ revoked: true, remaining: 1 });
    // The revoked token stops resolving; its sibling keeps working.
    expect(
      await PublishedArtifact.findOne({ deletedAt: null, ...shareTokenFilter(minted.body.shareToken) })
    ).toBeNull();
    expect(
      await PublishedArtifact.findOne({ deletedAt: null, ...shareTokenFilter(added.body.shareToken) })
    ).not.toBeNull();

    // The entry is stamped, never pulled: the token stays claimed in the unique index so it can
    // never be re-minted, and its view count survives.
    const afterOne = await raw();
    expect(afterOne.shareTokens).toHaveLength(2);
    expect(afterOne.shareTokens[0].revokedAt).toBeInstanceOf(Date);
    // The mirror follows the survivor rather than the link that was just revoked.
    expect(afterOne.shareToken).toBe(added.body.shareToken);
    expect(afterOne.shareTokenUpdatedAt).toEqual(afterOne.shareTokens[1].createdAt);
    expect(afterOne).not.toHaveProperty('__live'); // the scratch field never persists

    await call({ method: 'DELETE' });
    const afterAll_ = await raw();
    // $$REMOVE really unsets the scalar rather than writing null.
    expect(afterAll_).not.toHaveProperty('shareToken');
    expect(liveShareTokens(afterAll_ as never)).toHaveLength(0);

    // A plain mint after revoke-all still passes its "no live entry" precondition.
    const reminted = await call();
    expect(reminted.status).toBe(200);
    expect((await raw()).shareTokens).toHaveLength(3);
  });

  it('treats an entry with NO revokedAt field as live', async () => {
    // The backfill writes an explicit null, but a hand-edited or older row may simply omit it,
    // and IS_LIVE has to read the same way liveShareTokens does.
    await seed({
      shareTokens: [{ _id: new mongoose.Types.ObjectId(), token: 'NOFIELD', createdAt: new Date(), viewCount: 0 }],
    });
    const state = await call({ method: 'GET' });
    expect(state.body.shareLinks.map((l: { shareToken: string }) => l.shareToken)).toEqual(['NOFIELD']);

    // ...and a mint is refused as idempotent rather than adding a second live link.
    const minted = await call();
    expect(minted.body.shareToken).toBe('NOFIELD');
    expect((await raw()).shareTokens).toHaveLength(1);
  });

  it('rescues a pre-backfill scalar-only link when adding another, instead of overwriting it', async () => {
    // The pipeline sets the scalar to the new token. On a row the backfill missed that is the
    // ONLY copy of the existing link, so it has to be folded into the array in the same write.
    await seed({ shareToken: 'LEGACY', shareTokenUpdatedAt: new Date('2026-09-10T00:00:00.000Z'), shareTokens: [] });

    const added = await call({ body: { additional: true } });
    expect(added.body.shareLinks).toHaveLength(2);
    // The URL the owner already shared still resolves.
    expect(await PublishedArtifact.findOne({ deletedAt: null, ...shareTokenFilter('LEGACY') })).not.toBeNull();
    const stored = await raw();
    expect(stored.shareTokens.map((e: { token: string }) => e.token)).toEqual(['LEGACY', added.body.shareToken]);
    expect(stored.shareTokens[0].createdAt).toEqual(new Date('2026-09-10T00:00:00.000Z'));
  });

  it('cannot orphan a gate when two revoke-by-id calls race for the last two links', async () => {
    // Each call reads a snapshot showing one survivor, so the in-memory check alone would let
    // both through and leave a stored gate with nothing enforcing it.
    await seed({ accessGate: { kind: 'passphrase', passphraseHash: 'x' }, visibility: 'private' });
    const a = await call();
    const b = await call({ body: { additional: true } });

    const [first, second] = await Promise.all([
      call({ method: 'DELETE', query: { id: a.body.id } }),
      call({ method: 'DELETE', query: { id: b.body.id } }),
    ]);

    // Exactly one wins; the loser gets the same refusal the sequential path gives.
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 400]);
    const loser = first.status === 400 ? first : second;
    expect(loser.body.code).toBe('REVOKE_WOULD_ORPHAN_GATE');
    // The gate still has a surface enforcing it.
    expect(liveShareTokens((await raw()) as never)).toHaveLength(1);
  });

  it('lets a rotate win over a concurrent rotate without either caller holding a dead link', async () => {
    await seed();
    await call();
    const [x, y] = await Promise.all([call({ body: { regenerate: true } }), call({ body: { regenerate: true } })]);

    // Both callers get 200, and each returned token must be one that actually resolves - the
    // loser is handed the persisted token rather than the one whose write lost.
    for (const result of [x, y]) {
      expect(result.status).toBe(200);
      expect(
        await PublishedArtifact.findOne({ deletedAt: null, ...shareTokenFilter(result.body.shareToken) })
      ).not.toBeNull();
    }
    // A rotate revokes every outstanding link, so exactly one survives.
    expect(liveShareTokens((await raw()) as never)).toHaveLength(1);
  });
});
