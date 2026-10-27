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
  it('drops a rebuilt shareToken_1 and keeps the shareTokens.token index', async () => {
    await PublishedArtifact.collection.createIndex(
      { shareToken: 1 },
      { unique: true, partialFilterExpression: { shareToken: { $type: 'string' } } }
    );
    expect(await indexNames()).toContain('shareToken_1');

    await migration.up();

    expect(await indexNames()).not.toContain('shareToken_1');
    expect(await indexNames()).toContain('shareTokens.token_1');
  });

  it('is a no-op when the index is already gone', async () => {
    await migration.up();
    expect(await indexNames()).not.toContain('shareToken_1');
  });

  it('is not rebuilt by the current schema', async () => {
    await PublishedArtifact.createIndexes();
    expect(await indexNames()).not.toContain('shareToken_1');
  });
});
