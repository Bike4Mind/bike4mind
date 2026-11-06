import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Quest } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration, { SIGNUP_ACTIVITY_INDEX_NAME } from './20260921237490_drop-quest-signup-activity';
import { AvailableMigrations } from './index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const LEGACY_INDEX_KEY = { 'signupActivity.userId': 1, status: 1, 'signupActivity.startedAt': 1 };

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
  await mongoose.connection.db?.dropDatabase();
  await mongoose.connection.db?.createCollection(Quest.collection.collectionName);
});

const indexNames = async () => (await Quest.collection.indexes()).map(index => index.name);

const createLegacyIndex = () =>
  Quest.collection.createIndex(LEGACY_INDEX_KEY, {
    name: SIGNUP_ACTIVITY_INDEX_NAME,
    partialFilterExpression: { 'signupActivity.userId': { $exists: true } },
  });

describe('drop quest signup activity migration', () => {
  it('is registered and stays below the signup grant pool seed', () => {
    expect(AvailableMigrations).toContain(migration);
    const poolSeed = AvailableMigrations.find(m => m.name === 'seed-signup-grant-pools');
    expect(poolSeed).toBeDefined();
    expect(migration.id).toBeLessThan(poolSeed!.id);
  });

  it('clears the field from every stamped quest and drops the index', async () => {
    await createLegacyIndex();
    const startedAt = new Date();
    await Quest.collection.insertMany([
      ...Array.from({ length: 1005 }, (_, i) => ({
        sessionId: 's',
        status: 'done',
        signupActivity: { userId: `u${i}`, turnId: `t${i}`, startedAt },
      })),
      { sessionId: 's', status: 'done', prompt: 'untouched' },
    ]);

    await migration.up();

    expect(await Quest.collection.countDocuments({ signupActivity: { $exists: true } })).toBe(0);
    expect(await Quest.collection.countDocuments({})).toBe(1006);
    expect(await Quest.collection.findOne({ prompt: 'untouched' })).toMatchObject({ sessionId: 's' });
    expect(await indexNames()).not.toContain(SIGNUP_ACTIVITY_INDEX_NAME);
  });

  it('does not throw when the index was never built', async () => {
    await expect(migration.up()).resolves.toBeUndefined();
    await expect(migration.up()).resolves.toBeUndefined();
    expect(await indexNames()).not.toContain(SIGNUP_ACTIVITY_INDEX_NAME);
  });

  it('rebuilds the partial index on down', async () => {
    await createLegacyIndex();
    await migration.up();
    await migration.down();

    const index = (await Quest.collection.indexes()).find(i => i.name === SIGNUP_ACTIVITY_INDEX_NAME);
    expect(index?.key).toEqual(LEGACY_INDEX_KEY);
    expect(index?.partialFilterExpression).toEqual({ 'signupActivity.userId': { $exists: true } });
  });
});
