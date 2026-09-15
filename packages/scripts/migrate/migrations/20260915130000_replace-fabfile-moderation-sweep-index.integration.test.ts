import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FabFile, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// mirrors the sibling ensure-*-index tests' guard.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260915130000_replace-fabfile-moderation-sweep-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const OLD_INDEX = 'moderationStatus_1_deletedAt_1_createdAt_1';
const NEW_INDEX = 'moderationStatus_1_deletedAt_1_moderationAttempts_1_createdAt_1';

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
  await mongoose.connection.db?.createCollection(FabFile.collection.collectionName).catch(() => {});
  await FabFile.collection.deleteMany({});
  await safeDropIndex(FabFile.collection, OLD_INDEX);
  await safeDropIndex(FabFile.collection, NEW_INDEX);
});

// Real mongod: reproduces the exact environment the migration ships into - one that already built
// the pre-existing index this PR's schema change orphans - which a fresh-mongod unit test never
// exercises.
describe('replace-fabfile-moderation-sweep-index migration (real DB)', () => {
  it('drops the superseded index and builds its replacement', async () => {
    // Simulate an environment that already has the pre-this-PR index built.
    await FabFile.collection.createIndex({ moderationStatus: 1, deletedAt: 1, createdAt: 1 });
    let names = (await FabFile.collection.indexes()).map(i => i.name);
    expect(names).toContain(OLD_INDEX);
    expect(names).not.toContain(NEW_INDEX);

    await migration.up();

    names = (await FabFile.collection.indexes()).map(i => i.name);
    expect(names).not.toContain(OLD_INDEX);
    expect(names).toContain(NEW_INDEX);
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const names = (await FabFile.collection.indexes()).map(i => i.name);
    expect(names).not.toContain(OLD_INDEX);
    expect(names).toContain(NEW_INDEX);
  });

  it('is a no-op when the old index was never built', async () => {
    await migration.up();

    const names = (await FabFile.collection.indexes()).map(i => i.name);
    expect(names).not.toContain(OLD_INDEX);
    expect(names).toContain(NEW_INDEX);
  });
});
