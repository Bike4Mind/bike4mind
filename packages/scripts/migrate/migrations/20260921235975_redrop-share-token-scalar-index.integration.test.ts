import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import mongoose from 'mongoose';
import { PublishedArtifact } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235975_redrop-share-token-scalar-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  await PublishedArtifact.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const indexNames = async () => (await PublishedArtifact.collection.indexes()).map(i => i.name);

describe('redrop-share-token-scalar-index', () => {
  it('drops a rebuilt shareToken_1 for good and keeps the shareTokens.token index', async () => {
    await PublishedArtifact.collection.createIndex(
      { shareToken: 1 },
      { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } }
    );
    expect(await indexNames()).toContain('shareToken_1');

    await migration.up();
    // What autoIndex does on the next cold boot: builds every index the current schema declares.
    await PublishedArtifact.createIndexes();

    expect(await indexNames()).not.toContain('shareToken_1');
    expect(await indexNames()).toContain('shareTokens.token_1');
  });

  it('unsets stray legacy scalars and leaves shareTokens alone', async () => {
    const { insertedId } = await PublishedArtifact.collection.insertOne({
      publicId: 'pub-stray',
      tier: 'user',
      scopeId: 'scope1',
      slug: 'stray',
      title: 'T',
      ownerId: 'owner1',
      source: { kind: 'bundle' },
      shareToken: 'STRAY',
      shareTokenUpdatedAt: new Date(),
      shareTokens: [{ token: 'STRAY', revokedAt: null }],
    });

    await migration.up();

    const row = await PublishedArtifact.collection.findOne({ _id: insertedId });
    expect(row).not.toHaveProperty('shareToken');
    expect(row).not.toHaveProperty('shareTokenUpdatedAt');
    expect(row?.shareTokens).toHaveLength(1);
  });

  it('is a no-op on a second run', async () => {
    await migration.up();
    await migration.up();
    expect(await indexNames()).not.toContain('shareToken_1');
  });
});
