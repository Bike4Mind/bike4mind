import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer } from '../../__test__/createMongoServer';
import {
  PublishedArtifact,
  publishedArtifactRepository,
  liveShareTokens,
  shareTokenFilter,
} from './PublishedArtifactModel';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Build indexes (incl. the partial-unique shareToken index) before asserting on them.
  await PublishedArtifact.init();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

let seq = 0;
const make = (over: Record<string, unknown> = {}) => {
  seq += 1;
  return PublishedArtifact.create({
    publicId: `pub-${seq}`,
    tier: 'user',
    scopeId: 'scope1',
    slug: `slug-${seq}`,
    title: 'T',
    ownerId: 'owner1',
    source: { kind: 'bundle' },
    ...over,
  });
};

describe('PublishedArtifact shareToken', () => {
  it('allows many rows with NO shareToken (partial index does not force uniqueness on absent tokens)', async () => {
    await make();
    await make();
    const untokened = await PublishedArtifact.countDocuments({ shareToken: { $exists: false } });
    expect(untokened).toBeGreaterThanOrEqual(2);
  });

  it('rejects two rows sharing the same shareToken', async () => {
    await make({ shareToken: 'DUPLICATE' });
    await expect(make({ shareToken: 'DUPLICATE' })).rejects.toThrow();
  });

  it('findByShareToken resolves a live row and skips a soft-deleted one', async () => {
    const doc = await make({ shareToken: 'LIVE-TOKEN' });
    const found = await publishedArtifactRepository.findByShareToken('LIVE-TOKEN');
    expect(found?.publicId).toBe(doc.publicId);

    await PublishedArtifact.updateOne({ _id: doc._id }, { $set: { deletedAt: new Date() } });
    expect(await publishedArtifactRepository.findByShareToken('LIVE-TOKEN')).toBeFalsy();
  });

  it('toJSON never serializes the capability token', async () => {
    const doc = await make({ shareToken: 'SECRET-TOKEN' });
    const json = doc.toJSON() as Record<string, unknown>;
    expect(json.publicId).toBe(doc.publicId); // real fields survive
    expect(json.shareToken).toBeUndefined();
    expect(json.shareTokenUpdatedAt).toBeUndefined();
  });

  it('a projected lean read (the management GET) omits the token', async () => {
    const doc = await make({ shareToken: 'PROJECTED-OUT' });
    const lean = await PublishedArtifact.findOne({ _id: doc._id })
      .select('-shareToken -shareTokenUpdatedAt')
      .lean<Record<string, unknown>>();
    expect(lean?.publicId).toBe(doc.publicId);
    expect(lean?.shareToken).toBeUndefined();
  });

  // --- shareTokens[] (#3255 step 1) -------------------------------------------------------

  it('resolves a token held ONLY in the array (post-rollout shape)', async () => {
    const doc = await make({ shareTokens: [{ token: 'ARRAY-ONLY', revokedAt: null }] });
    const found = await publishedArtifactRepository.findByShareToken('ARRAY-ONLY');
    expect(found?.publicId).toBe(doc.publicId);
  });

  it('does NOT resolve a revoked array entry, even alongside a live one', async () => {
    // The live entry is what makes this worth asserting: a naive query that matched `token` and
    // `revokedAt: null` as two independent conditions would let the revoked one through on the
    // strength of its neighbour.
    await make({
      shareTokens: [
        { token: 'DEAD', revokedAt: new Date() },
        { token: 'ALIVE', revokedAt: null },
      ],
    });
    expect(await publishedArtifactRepository.findByShareToken('DEAD')).toBeFalsy();
    expect(await publishedArtifactRepository.findByShareToken('ALIVE')).toBeTruthy();
  });

  it('rejects the same token on two rows via the array index', async () => {
    await make({ shareTokens: [{ token: 'ARRAY-DUP' }] });
    await expect(make({ shareTokens: [{ token: 'ARRAY-DUP' }] })).rejects.toThrow();
  });

  it('keeps rows with an EMPTY array out of the partial-unique index', async () => {
    // The `$type: 'string'` filter is on `shareTokens.token`, a path an empty array does not
    // have - so many link-less rows coexist, which is the whole reason the filter survived the
    // move off the scalar.
    await expect(make({ shareTokens: [] })).resolves.toBeTruthy();
    await expect(make({ shareTokens: [] })).resolves.toBeTruthy();
  });

  it('toJSON strips each entry token but keeps the id, timestamps and count', async () => {
    const doc = await make({ shareTokens: [{ token: 'SECRET-ENTRY', viewCount: 7 }] });
    const json = doc.toJSON() as { shareTokens: Record<string, unknown>[] };
    expect(json.shareTokens).toHaveLength(1);
    expect(json.shareTokens[0].token).toBeUndefined();
    expect(json.shareTokens[0].viewCount).toBe(7);
    expect(json.shareTokens[0]._id).toBeDefined(); // the handle the owner UI revokes by
  });

  it('a projected lean read omits entry tokens but keeps the entries', async () => {
    const doc = await make({ shareTokens: [{ token: 'PROJECTED-ENTRY', viewCount: 3 }] });
    const lean = await PublishedArtifact.findOne({ _id: doc._id })
      .select('-shareToken -shareTokenUpdatedAt -shareTokens.token')
      .lean<{ shareTokens: Record<string, unknown>[] }>();
    expect(lean?.shareTokens[0].token).toBeUndefined();
    expect(lean?.shareTokens[0].viewCount).toBe(3);
  });

  it('gives a migrated artifact ONE live link, not one per shape', async () => {
    // What the backfill leaves behind: scalar and array both holding the same token. Counting
    // them separately would show the owner two links where they have one.
    const doc = await make({ shareToken: 'MIRRORED', shareTokens: [{ token: 'MIRRORED', revokedAt: null }] });
    expect(liveShareTokens(doc)).toHaveLength(1);
  });

  it('folds an un-mirrored legacy token in, so a pre-backfill row still reports its link', async () => {
    const doc = await make({ shareToken: 'LEGACY-ONLY' });
    expect(liveShareTokens(doc).map(e => e.token)).toEqual(['LEGACY-ONLY']);
  });
});

describe('per-entry view counting (#3255 step 2)', () => {
  // The serve route counts a share view with an arrayFilters update built on the entry's real
  // ObjectId. The route's own suite mocks the driver, so the ObjectId round trip and the no-match
  // behavior are only ever exercised here, against real Mongo.
  const bump = (publicId: string, entryId: unknown) =>
    PublishedArtifact.updateOne(
      { publicId },
      {
        $inc: { viewCount: 1, 'shareTokens.$[entry].viewCount': 1 },
        $set: { 'shareTokens.$[entry].lastViewedAt': new Date() },
      },
      { arrayFilters: [{ 'entry._id': entryId }] }
    );

  it('increments only the matched entry, leaving its siblings untouched', async () => {
    const doc = await make({
      shareToken: 'COUNT-A',
      shareTokens: [{ token: 'COUNT-A' }, { token: 'COUNT-B' }],
    });
    const [first, second] = doc.shareTokens!;

    await bump(doc.publicId, first._id);
    await bump(doc.publicId, first._id);

    const after = await PublishedArtifact.findOne({ publicId: doc.publicId }).lean();
    expect(after!.shareTokens![0].viewCount).toBe(2);
    expect(after!.shareTokens![0].lastViewedAt).toBeInstanceOf(Date);
    expect(after!.shareTokens![1].viewCount).toBe(0);
    expect(after!.shareTokens![1].lastViewedAt).toBeNull();
    expect(after!.viewCount).toBe(2);
    expect(second._id).toBeDefined();
  });

  it('leaves the artifact counter intact when arrayFilters matches nothing', async () => {
    const doc = await make({ shareToken: 'NO-MATCH', shareTokens: [{ token: 'NO-MATCH' }] });

    await bump(doc.publicId, new mongoose.Types.ObjectId());

    const after = await PublishedArtifact.findOne({ publicId: doc.publicId }).lean();
    // The aggregate bump still lands; only the per-entry half is a no-op. This is the shape a
    // stale entry id would produce, and it must not cost the artifact its view.
    expect(after!.viewCount).toBe(1);
    expect(after!.shareTokens![0].viewCount).toBe(0);
  });

  it('shareTokenFilter resolves both shapes and refuses a revoked entry', async () => {
    const legacy = await make({ shareToken: 'SCALAR-ONLY' });
    const arrayed = await make({ shareTokens: [{ token: 'ARRAY-LIVE' }] });
    await make({ shareTokens: [{ token: 'ARRAY-DEAD', revokedAt: new Date() }, { token: 'SIBLING-LIVE' }] });

    const find = (token: string) => PublishedArtifact.findOne({ deletedAt: null, ...shareTokenFilter(token) }).lean();

    expect((await find('SCALAR-ONLY'))?.publicId).toBe(legacy.publicId);
    expect((await find('ARRAY-LIVE'))?.publicId).toBe(arrayed.publicId);
    // The $elemMatch is what stops this one resolving on SIBLING-LIVE's strength.
    expect(await find('ARRAY-DEAD')).toBeNull();
  });
});
