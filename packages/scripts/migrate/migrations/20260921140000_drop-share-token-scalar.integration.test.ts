import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { PublishedArtifact, liveShareTokens, shareTokenFilter } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921140000_drop-share-token-scalar';

// Boots a real mongod - see MONGO_TEST_TIMEOUT_MS for why 30s is not enough.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await PublishedArtifact.deleteMany({});
});

let seq = 0;
/**
 * Inserted through the RAW collection, for the reason the backfill's test gives: #3523 took
 * `shareToken` off the schema, so Mongoose strict mode drops it on the way in and a `create()`
 * here would seed the very state this migration is supposed to repair as already repaired.
 */
const artifact = async (over: Record<string, unknown> = {}) => {
  seq += 1;
  const doc = {
    publicId: `pub-${seq}`,
    tier: 'user',
    scopeId: 'scope1',
    slug: `slug-${seq}`,
    title: 'T',
    ownerId: 'owner1',
    source: { kind: 'bundle' },
    shareTokens: [],
    deletedAt: null,
    ...over,
  };
  await PublishedArtifact.collection.insertOne(doc as never);
  return doc as { publicId: string };
};

/** The row exactly as it persists, so an absent key is distinguishable from a null one. */
const raw = async (publicId: string) =>
  (await PublishedArtifact.collection.findOne({ publicId }))! as Record<string, unknown> & {
    shareTokens?: { _id?: unknown; token?: string; createdAt?: Date; revokedAt?: Date | null }[];
  };

const entry = (token: string, over: Record<string, unknown> = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  token,
  createdAt: new Date('2026-09-20T00:00:00.000Z'),
  revokedAt: null,
  viewCount: 0,
  lastViewedAt: null,
  ...over,
});

describe('drop-share-token-scalar up', () => {
  it('mirrors a stranded scalar-only link into the array before unsetting it', async () => {
    // The case the whole migration turns on. Such a row has not been touched since before the
    // 20260921130000 backfill, so its one link exists ONLY in the scalar - and once
    // `shareTokenFilter` stops looking there, that URL is dead. Mirroring is what keeps a link
    // someone may still be holding alive.
    const updatedAt = new Date('2026-09-10T00:00:00.000Z');
    const doc = await artifact({ shareToken: 'STRANDED', shareTokenUpdatedAt: updatedAt, shareTokens: [] });

    await migration.up();

    const row = await raw(doc.publicId);
    expect(row.shareTokens).toHaveLength(1);
    expect(row.shareTokens![0].token).toBe('STRANDED');
    expect(row.shareTokens![0].revokedAt).toBeNull();
    // A real _id, because it is the handle the owner UI revokes a single link by. A mirrored link
    // with no id would list as unrevokable - the exact nullability #3523 removes.
    expect(row.shareTokens![0]._id).toBeDefined();
    // Dated from the row rather than the deploy: the owner's list shows when a link was created,
    // and stamping every migrated link "today" tells them the wrong thing. Same fallback chain as
    // the backfill, so a row healed by either lands identically.
    expect(row.shareTokens![0].createdAt?.toISOString()).toBe(updatedAt.toISOString());

    // ...and the link still resolves through the array-only filter, which is the point.
    expect(await PublishedArtifact.findOne({ deletedAt: null, ...shareTokenFilter('STRANDED') })).not.toBeNull();
  });

  it('unsets both scalars everywhere, including on a row that never had a link', async () => {
    const shared = await artifact({ shareToken: 'MIRRORED', shareTokens: [entry('MIRRORED')] });
    // `shareTokenUpdatedAt` had a schema default of null, so even never-shared rows carry the key
    // - a filter on the token alone would leave those behind.
    const never = await artifact({ shareTokenUpdatedAt: null });

    await migration.up();

    for (const { publicId } of [shared, never]) {
      const row = await raw(publicId);
      expect(row).not.toHaveProperty('shareToken');
      expect(row).not.toHaveProperty('shareTokenUpdatedAt');
    }
  });

  it('does not duplicate a link the backfill already mirrored', async () => {
    // The normal case: scalar and array both holding the same token. Pushing again would give the
    // owner two rows for one link, and the unique index would reject the duplicate anyway.
    const doc = await artifact({ shareToken: 'MIRRORED', shareTokens: [entry('MIRRORED')] });

    await migration.up();

    const row = await raw(doc.publicId);
    expect(row.shareTokens).toHaveLength(1);
    expect(liveShareTokens(row as never)).toHaveLength(1);
  });

  it('does NOT resurrect a link whose entry is already revoked', async () => {
    // A row whose scalar still names a token the array holds as REVOKED. That link was
    // deliberately killed; re-adding it live would hand it back. Matched on the token alone,
    // revoked entries included, precisely so this cannot happen.
    const doc = await artifact({
      shareToken: 'KILLED',
      shareTokens: [entry('KILLED', { revokedAt: new Date('2026-09-25T00:00:00.000Z') })],
    });

    await migration.up();

    const row = await raw(doc.publicId);
    expect(row.shareTokens).toHaveLength(1);
    expect(row.shareTokens![0].revokedAt).toBeInstanceOf(Date);
    expect(liveShareTokens(row as never)).toHaveLength(0);
    expect(await PublishedArtifact.findOne({ deletedAt: null, ...shareTokenFilter('KILLED') })).toBeNull();
  });

  it('drops the legacy partial-unique index', async () => {
    await artifact({ shareToken: 'INDEXED' });
    await PublishedArtifact.collection.createIndex(
      { shareToken: 1 },
      { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } }
    );
    expect((await PublishedArtifact.collection.indexes()).map(i => i.name)).toContain('shareToken_1');

    await migration.up();

    // Unsetting the field alone would leave a unique index over a path no document has - dead
    // weight, and a trap for anyone who reuses the field name later.
    expect((await PublishedArtifact.collection.indexes()).map(i => i.name)).not.toContain('shareToken_1');
  });

  it('is idempotent, including when the index is already gone', async () => {
    const doc = await artifact({ shareToken: 'ONCE', shareTokens: [] });

    await migration.up();
    await migration.up();

    const row = await raw(doc.publicId);
    expect(row.shareTokens).toHaveLength(1);
    expect(row).not.toHaveProperty('shareToken');
  });

  it('survives being interrupted between mirroring and unsetting', async () => {
    // A crash there leaves links mirrored but scalars present - the pre-migration state plus some
    // healed rows. Simulated by running `up` twice over a row re-seeded with its scalar: the
    // second pass must not add a second entry.
    const doc = await artifact({ shareToken: 'RESUMED', shareTokens: [] });
    await migration.up();
    await PublishedArtifact.collection.updateOne({ publicId: doc.publicId }, { $set: { shareToken: 'RESUMED' } });

    await migration.up();

    expect((await raw(doc.publicId)).shareTokens).toHaveLength(1);
  });
});

describe('drop-share-token-scalar down', () => {
  it('restores the scalars from the newest live entry, so a rolled-back build serves a link', async () => {
    const doc = await artifact({
      shareTokens: [entry('OLDER'), entry('NEWEST', { createdAt: new Date('2026-09-28T00:00:00.000Z') })],
    });

    await migration.down!();

    const row = await raw(doc.publicId);
    // Newest LAST is the array's append order, and the newest live link is what the retired
    // mirror held - so this is the value a pre-#3523 build would itself re-derive.
    expect(row.shareToken).toBe('NEWEST');
    expect((row.shareTokenUpdatedAt as Date).toISOString()).toBe('2026-09-28T00:00:00.000Z');
    expect(row).not.toHaveProperty('__live'); // the scratch field never persists
  });

  it('leaves no scalar on a row with nothing live', async () => {
    // Which is what an artifact that was never shared has always looked like. A revoked-only row
    // must not get a scalar naming a dead link - a rolled-back build would serve it.
    const revoked = await artifact({ shareTokens: [entry('DEAD', { revokedAt: new Date() })] });
    const bare = await artifact();

    await migration.down!();

    for (const { publicId } of [revoked, bare]) {
      const row = await raw(publicId);
      expect(row).not.toHaveProperty('shareToken');
      expect(row.shareTokenUpdatedAt).toBeNull();
    }
  });

  it('recreates the index a rolled-back build looks up tokens through', async () => {
    await artifact({ shareTokens: [entry('ROLLED-BACK')] });

    await migration.down!();

    expect((await PublishedArtifact.collection.indexes()).map(i => i.name)).toContain('shareToken_1');
  });

  it('round-trips: up then down leaves a stranded link live in BOTH shapes', async () => {
    // The end-to-end rollback story for the one row that mattered. `up` mirrors the stranded link
    // into the array; `down` puts the scalar back from it - so a build on either side of the
    // migration serves that URL. What cannot come back is WHICH entry the scalar named on a row
    // whose newest live link has since been revoked; see the `down` doc comment.
    const doc = await artifact({
      shareToken: 'ROUNDTRIP',
      shareTokenUpdatedAt: new Date('2026-09-10T00:00:00.000Z'),
      shareTokens: [],
    });

    await migration.up();
    await migration.down!();

    const row = await raw(doc.publicId);
    expect(row.shareToken).toBe('ROUNDTRIP');
    expect(row.shareTokens).toHaveLength(1);
    expect(row.shareTokens![0].token).toBe('ROUNDTRIP');
    expect((row.shareTokenUpdatedAt as Date).toISOString()).toBe('2026-09-10T00:00:00.000Z');
  });
});
