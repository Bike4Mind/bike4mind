import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Session } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';
import migration from './20261126094502_ensure-session-list-keyset-indexes';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await Session.createCollection();
});
afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const keyOf = (index: { key: Record<string, unknown> }) => JSON.stringify(index.key);

describe('session list keyset index migration', () => {
  it('builds the _id-tiebreak list indexes and drops the ones they extend, idempotently', async () => {
    await Session.collection.createIndex({ deletedAt: 1, userId: 1, lastUpdated: -1 });
    await Session.collection.createIndex({ deletedAt: 1, userId: 1, 'origin.channel': 1, lastUpdated: -1 });

    await migration.up();
    await migration.up();

    const keys = (await Session.collection.indexes()).map(keyOf);
    expect(keys).toContain(JSON.stringify({ deletedAt: 1, userId: 1, lastUpdated: -1, _id: -1 }));
    expect(keys).toContain(JSON.stringify({ deletedAt: 1, userId: 1, 'origin.channel': 1, lastUpdated: -1, _id: -1 }));
    expect(keys).not.toContain(JSON.stringify({ deletedAt: 1, userId: 1, lastUpdated: -1 }));
    expect(keys).not.toContain(JSON.stringify({ deletedAt: 1, userId: 1, 'origin.channel': 1, lastUpdated: -1 }));
  });
});
