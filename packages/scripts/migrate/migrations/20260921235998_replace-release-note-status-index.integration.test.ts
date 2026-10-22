import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { ReleaseNote } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921235998_replace-release-note-status-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const NEW_KEY = { status: 1, publishAt: -1, _id: -1 };
const OLD_KEY = { status: 1, publishAt: -1 };

let server: Awaited<ReturnType<typeof createMongoServer>>;

const keys = async () => (await ReleaseNote.collection.indexes()).map(index => index.key);

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle autoIndex before beforeEach drops the collection, so it cannot rebuild indexes mid-test.
  await ReleaseNote.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  await ReleaseNote.collection.drop().catch(() => {});
});

describe('replace-release-note-status-index migration (real DB)', () => {
  it('creates the keyset index on a fresh database that never created the collection', async () => {
    await migration.up();

    expect(await keys()).toContainEqual(NEW_KEY);
  });

  it('drops the old index by key pattern even when its name is not the auto-derived one', async () => {
    await mongoose.connection.db?.createCollection(ReleaseNote.collection.collectionName);
    await ReleaseNote.collection.createIndex(OLD_KEY, { name: 'engine_specific_name' });

    await migration.up();

    const after = await keys();
    expect(after).not.toContainEqual(OLD_KEY);
    expect(after).toContainEqual(NEW_KEY);
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    expect(await keys()).toContainEqual(NEW_KEY);
  });
});
