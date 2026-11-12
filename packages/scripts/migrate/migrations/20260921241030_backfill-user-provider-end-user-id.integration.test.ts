import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { Migration } from '@bike4mind/database';
import { toProviderEndUserId } from '@bike4mind/llm-adapters';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921241030_backfill-user-provider-end-user-id';
import repair from './20260921241032_repair-provider-end-user-id-migration-collision';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let server: Awaited<ReturnType<typeof createMongoServer>> | undefined;

const users = () => {
  const db = mongoose.connection.db;
  if (!db) throw new Error('Database connection not established');
  return db.collection('users');
};

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});
afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});
beforeEach(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await users().deleteMany({});
  await Migration.deleteMany({});
});

describe('backfill user providerEndUserId', () => {
  it('stamps every legacy account with the hash of its id and builds the unique index', async () => {
    const { insertedIds } = await users().insertMany(
      Array.from({ length: 3 }, (_, index) => ({ username: `legacy-${index}`, name: 'Legacy' }))
    );

    await migration.up();

    for (const id of Object.values(insertedIds)) {
      const row = await users().findOne({ _id: id });
      expect(row?.providerEndUserId).toBe(toProviderEndUserId(String(id)));
    }
    const index = (await users().indexes()).find(candidate => candidate.name === 'user_providerEndUserId');
    expect(index).toMatchObject({ key: { providerEndUserId: 1 }, unique: true });
  });

  it('catches up a payments-only preview without overwriting stamped identifiers', async () => {
    await Migration.create({ id: migration.id, name: 'ensure payments report indexes' });
    const { insertedId } = await users().insertOne({ username: 'legacy-preview' });
    const stamped = await users().insertOne({ username: 'stamped-preview', providerEndUserId: 'kept' });
    await repair.up();
    await repair.up();
    expect((await users().findOne({ _id: insertedId }))?.providerEndUserId).toBe(
      toProviderEndUserId(String(insertedId))
    );
    expect((await users().findOne({ _id: stamped.insertedId }))?.providerEndUserId).toBe('kept');
  });

  it('leaves an already-stamped account alone and is safe to re-run', async () => {
    const { insertedId } = await users().insertOne({ username: 'stamped', name: 'S', providerEndUserId: 'kept' });

    await migration.up();
    await migration.up();

    expect((await users().findOne({ _id: insertedId }))?.providerEndUserId).toBe('kept');
  });
});
