import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Artifact, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Same guard as the sibling index migrations' tests.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235993_ensure-artifact-owned-keyset-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'userId_1_deletedAt_1__id_1';
// Another index the schema declares. The migration builds ONE index by name so a prod DocumentDB
// run does not also build every other declared index (the text index included) under the same
// foreground lock; dropping this one and asserting it stays gone is what guards that narrowing.
const OTHER_DECLARED_INDEX = 'sourceQuestId_1';

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before the hooks below drop indexes - see createMongoServer's autoIndex note.
  await Artifact.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await mongoose.connection.db?.createCollection(Artifact.collection.collectionName).catch(() => {});
  await Artifact.collection.deleteMany({});
  // autoIndex may have built it on connect; the migration's job is to build it where it is absent.
  await safeDropIndex(Artifact.collection, INDEX_NAME);
  await safeDropIndex(Artifact.collection, OTHER_DECLARED_INDEX);
});

describe('ensure-artifact-owned-keyset-index migration (real DB)', () => {
  it('builds the owned-artifacts keyset index the public artifact list reads through', async () => {
    let idx = (await Artifact.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    const indexes = await Artifact.collection.indexes();
    idx = indexes.find(i => i.name === INDEX_NAME);
    // Key ORDER is the point: the equality prefix, then `_id` last so a page streams in keyset order.
    expect(idx?.key).toEqual({ userId: 1, deletedAt: 1, _id: 1 });
    // createIndexes() would rebuild this one too - the narrowing is what keeps a prod build to a
    // single index.
    expect(indexes.find(i => i.name === OTHER_DECLARED_INDEX)).toBeUndefined();
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await Artifact.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });
});
