import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { Organization, safeDropIndex } from '@bike4mind/database';
import { createMongoServer } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling drop-legacy-fabfilechunk test's guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260813000001_ensure-organization-member-index';

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
  // Ensure the collection exists before touching indexes on a fresh mongod - listIndexes/
  // dropIndex throw NamespaceNotFound against a collection that was never created, unlike
  // deleteMany (mirrors 20260810000000_drop-legacy-fabfilechunk-indexes's own guard).
  await mongoose.connection.db?.createCollection(Organization.collection.collectionName).catch(() => {});
  await Organization.collection.deleteMany({});
  // Ensure the index is absent before each test (autoIndex may have built it on connect).
  await safeDropIndex(Organization.collection, 'users.userId_1');
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a
// mocked collection can't verify.
describe('ensure-organization-member-index migration (real DB)', () => {
  it('builds the users.userId index used by findMembershipOrgIds', async () => {
    let idx = (await Organization.collection.indexes()).find(i => i.name === 'users.userId_1');
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await Organization.collection.indexes()).find(i => i.name === 'users.userId_1');
    expect(idx).toBeDefined();
  }, 30000);

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await Organization.collection.indexes()).find(i => i.name === 'users.userId_1');
    expect(idx).toBeDefined();
  }, 30000);
});
