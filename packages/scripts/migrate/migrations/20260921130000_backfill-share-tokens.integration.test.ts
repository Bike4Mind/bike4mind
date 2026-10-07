import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { PublishedArtifact } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling backfill tests' guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921130000_backfill-share-tokens';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
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
const artifact = (over: Record<string, unknown> = {}) => {
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

const entriesOf = async (publicId: string) => {
  const row = await PublishedArtifact.findOne({ publicId }).lean<{
    shareTokens?: { _id?: unknown; token?: string; createdAt?: Date; revokedAt?: Date | null }[];
  }>();
  return row?.shareTokens ?? [];
};

describe('backfill-share-tokens', () => {
  it('mirrors a legacy scalar token into a single live entry', async () => {
    const updatedAt = new Date('2026-01-02T03:04:05Z');
    const doc = await artifact({ shareToken: 'LEGACY', shareTokenUpdatedAt: updatedAt });

    await migration.up();

    const entries = await entriesOf(doc.publicId);
    expect(entries).toHaveLength(1);
    expect(entries[0].token).toBe('LEGACY');
    expect(entries[0].revokedAt).toBeNull();
    // The entry needs a real _id: it is the handle the owner UI revokes a single link by.
    expect(entries[0]._id).toBeDefined();
    // Dated from the row, not the deploy - the owner surface shows when the link was created.
    expect(entries[0].createdAt?.toISOString()).toBe(updatedAt.toISOString());
  });

  it('leaves a token-less artifact with an empty array', async () => {
    const doc = await artifact();
    await migration.up();
    expect(await entriesOf(doc.publicId)).toEqual([]);
  });

  it('is idempotent: a second run does not duplicate the entry', async () => {
    const doc = await artifact({ shareToken: 'ONCE' });
    await migration.up();
    await migration.up();
    expect(await entriesOf(doc.publicId)).toHaveLength(1);
  });

  it('does not re-add a token the app already mirrored', async () => {
    const doc = await artifact({ shareToken: 'MIRRORED', shareTokens: [{ token: 'MIRRORED', revokedAt: null }] });
    await migration.up();
    expect(await entriesOf(doc.publicId)).toHaveLength(1);
  });

  it('down removes the mirrored entry but keeps an independently minted one', async () => {
    const doc = await artifact({ shareToken: 'LEGACY' });
    await migration.up();
    await PublishedArtifact.updateOne(
      { publicId: doc.publicId },
      { $push: { shareTokens: { token: 'MINTED-AFTER', revokedAt: null } } }
    );

    await migration.down();

    expect((await entriesOf(doc.publicId)).map(e => e.token)).toEqual(['MINTED-AFTER']);
  });

  it('down keeps a REVOKED entry even when its token matches the scalar', async () => {
    // Its token has to stay claimed in the unique index; dropping it would let the same value be
    // minted again, resurrecting a link the owner revoked.
    const doc = await artifact({ shareToken: 'ROTATED', shareTokens: [{ token: 'ROTATED', revokedAt: new Date() }] });
    await migration.down();
    expect((await entriesOf(doc.publicId)).map(e => e.token)).toEqual(['ROTATED']);
  });
});
