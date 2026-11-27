import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { User, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Mirrors the sibling ensure-*-index tests' guard against SST config evaluation.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235973_ensure-user-signupmeta-capturedat-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'user_signupMeta_capturedAt';

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
  // listIndexes/dropIndex throw NamespaceNotFound against a never-created collection.
  await mongoose.connection.db?.createCollection(User.collection.collectionName).catch(() => {});
  await User.collection.deleteMany({});
  await safeDropIndex(User.collection, INDEX_NAME);
});

describe('ensure-user-signupMeta-capturedAt-index migration (real DB)', () => {
  it('builds the sparse capturedAt index the retention sweep ranges over', async () => {
    expect((await User.collection.indexes()).find(i => i.name === INDEX_NAME)).toBeUndefined();

    await migration.up();

    const idx = (await User.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx?.key).toEqual({ 'signupMeta.capturedAt': 1 });
    expect(idx?.sparse).toBe(true);
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    expect((await User.collection.indexes()).find(i => i.name === INDEX_NAME)).toBeDefined();
  });

  it('is the index the planner picks for the retention sweep, not a collection scan', async () => {
    await migration.up();
    const old = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    await User.collection.insertMany(
      Array.from({ length: 60 }, (_, i) => ({
        username: `user${i}`,
        email: `user${i}@example.com`,
        ...(i % 2 === 0 && { signupMeta: { ip: `203.0.113.${i}`, capturedAt: i % 4 === 0 ? old : new Date() } }),
      }))
    );

    const plan = await User.collection
      .find(
        // Same predicate shape as the cron: `$exists` is what lets DocumentDB use a sparse index.
        { 'signupMeta.capturedAt': { $exists: true, $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000) } },
        { projection: { 'signupMeta.ip': 1 } }
      )
      .explain('queryPlanner');

    // Serialized rather than walked: the winning plan's stage nesting differs across server versions.
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(winning).toContain(INDEX_NAME);
    expect(winning).not.toContain('COLLSCAN');
  });
});
