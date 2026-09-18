import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { User, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-*-index tests' guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260918010000_ensure-user-organizationid-index';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'user_organizationId';
const ORG_ID = new mongoose.Types.ObjectId();

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
  // listIndexes/dropIndex throw NamespaceNotFound against a collection that was never created on a
  // fresh mongod, unlike deleteMany (mirrors the sibling ensure-*-index tests' own guard).
  await mongoose.connection.db?.createCollection(User.collection.collectionName).catch(() => {});
  await User.collection.deleteMany({});
  await safeDropIndex(User.collection, INDEX_NAME);
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a
// mocked collection can't verify.
describe('ensure-user-organizationId-index migration (real DB)', () => {
  it('builds the organizationId index the org member lookup matches on', async () => {
    let idx = (await User.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await User.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ organizationId: 1 });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await User.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });

  it('is the index the planner picks for the member lookup, not a collection scan', async () => {
    // The key assertion above says the index exists; it says nothing about findMemberUserIds'
    // read actually landing on it rather than on COLLSCAN.
    await migration.up();
    await User.collection.insertMany(
      Array.from({ length: 60 }, (_, i) => ({
        username: `user${i}`,
        email: `user${i}@example.com`,
        organizationId: i % 3 === 0 ? ORG_ID : new mongoose.Types.ObjectId(),
      }))
    );

    const plan = await User.collection
      .find({ organizationId: ORG_ID }, { projection: { _id: 1 } })
      .explain('queryPlanner');

    // Serialized rather than walked: the winning plan's stage nesting differs across server
    // versions, and the only claim here is which index it settled on.
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(winning).toContain(INDEX_NAME);
    expect(winning).not.toContain('COLLSCAN');
  });
});
