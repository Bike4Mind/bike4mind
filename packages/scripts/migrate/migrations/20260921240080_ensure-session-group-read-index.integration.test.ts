import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Session } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20260921240080_ensure-session-group-read-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

describe('session group-read index rollout', () => {
  it('indexes an existing collection without changing its rows and can be rerun', async () => {
    await Session.collection.insertOne({
      userId: 'owner',
      deletedAt: null,
      groups: [{ groupId: 'shared', permissions: ['read'] }],
    });
    const before = await Session.collection.find({}).toArray();
    const hasGroupIndex = async () =>
      (await Session.collection.indexes()).some(
        index => index.key.deletedAt === 1 && index.key['groups.groupId'] === 1
      );
    expect(await hasGroupIndex()).toBe(false);
    await migration.up({ startedAt: new Date() });
    expect(await hasGroupIndex()).toBe(true);
    await migration.up({ startedAt: new Date() });
    expect(await Session.collection.find({}).toArray()).toEqual(before);
  });
});
