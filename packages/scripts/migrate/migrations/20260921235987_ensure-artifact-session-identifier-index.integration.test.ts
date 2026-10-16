import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Artifact, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Same guard as the sibling index migrations' tests.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235987_ensure-artifact-session-identifier-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'sessionId_1_identifier_1';
// Dropped and asserted to stay gone: the migration must build only its own index, not every
// declared one, under DocumentDB's foreground lock.
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
  await safeDropIndex(Artifact.collection, INDEX_NAME);
  await safeDropIndex(Artifact.collection, OTHER_DECLARED_INDEX);
});

describe('ensure-artifact-session-identifier-index migration (real DB)', () => {
  it('builds only the session identifier index', async () => {
    expect((await Artifact.collection.indexes()).find(i => i.name === INDEX_NAME)).toBeUndefined();

    await migration.up();

    const indexes = await Artifact.collection.indexes();
    expect(indexes.find(i => i.name === INDEX_NAME)?.key).toEqual({ sessionId: 1, identifier: 1 });
    expect(indexes.find(i => i.name === OTHER_DECLARED_INDEX)).toBeUndefined();
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    expect((await Artifact.collection.indexes()).find(i => i.name === INDEX_NAME)).toBeDefined();
  });
});
