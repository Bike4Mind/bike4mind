import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { DataLakeFindingModel, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-*-index tests' guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260921000000_ensure-data-lake-finding-indexes';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND hooks.
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const IDENTITY_INDEX = 'lakeId_1_detector_1_kind_1_subject_1';
const QUEUE_INDEX = 'lakeId_1_status_1_kind_1_lastSeenAt_-1';

const row = (overrides: Record<string, unknown> = {}) => ({
  lakeId: 'lake-1',
  detector: 'lexical',
  kind: 'metric-disagreement',
  subject: 'annual revenue usd',
  sources: [],
  documentCount: 2,
  status: 'open',
  firstSeenAt: new Date('2026-09-01T00:00:00Z'),
  lastSeenAt: new Date('2026-09-01T00:00:00Z'),
  ...overrides,
});

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
  // Settle mongoose's own autoIndex build BEFORE any test drops an index. That build is
  // fire-and-forget (see the migration's comment for why that is the whole reason this migration
  // exists), so without this the beforeEach drop races it: under suite load the background rebuild
  // lands after the drop and the "not there yet" assertion sees an index the migration did not
  // build. `init()` resolves once that build is done, after which nothing rebuilds behind us.
  await DataLakeFindingModel.init();
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

beforeEach(async () => {
  // listIndexes/dropIndex throw NamespaceNotFound against a collection that was never created on a
  // fresh mongod, unlike deleteMany (mirrors the sibling ensure-*-index tests' own guard).
  await mongoose.connection.db?.createCollection(DataLakeFindingModel.collection.collectionName).catch(() => {});
  await DataLakeFindingModel.collection.deleteMany({});
  await safeDropIndex(DataLakeFindingModel.collection, IDENTITY_INDEX);
  await safeDropIndex(DataLakeFindingModel.collection, QUEUE_INDEX);
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a mocked
// collection cannot verify.
describe('ensure-data-lake-finding-indexes migration (real DB)', () => {
  it('builds the unique identity index the upsert keys on', async () => {
    expect((await DataLakeFindingModel.collection.indexes()).find(i => i.name === IDENTITY_INDEX)).toBeUndefined();

    await migration.up();

    const idx = (await DataLakeFindingModel.collection.indexes()).find(i => i.name === IDENTITY_INDEX);
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ lakeId: 1, detector: 1, kind: 1, subject: 1 });
    expect(idx?.unique).toBe(true);
  });

  it('builds the queue index the finding list is served from', async () => {
    await migration.up();

    const idx = (await DataLakeFindingModel.collection.indexes()).find(i => i.name === QUEUE_INDEX);
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ lakeId: 1, status: 1, kind: 1, lastSeenAt: -1 });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    expect((await DataLakeFindingModel.collection.indexes()).filter(i => i.name === IDENTITY_INDEX)).toHaveLength(1);
  });

  it('actually refuses a duplicate finding once built', async () => {
    // The point of the migration, not just the presence of a named index: without the constraint,
    // two concurrent detection runs both insert and a curator gets the same problem twice.
    await migration.up();
    await DataLakeFindingModel.collection.insertOne(row());

    await expect(DataLakeFindingModel.collection.insertOne(row())).rejects.toMatchObject({ code: 11000 });
  });

  it('still admits the same subject under a different detector', async () => {
    // detector is part of the key on purpose: the reading pass (#3057) reporting the same topic is
    // a second finding for a curator to see, not a duplicate to suppress.
    await migration.up();
    await DataLakeFindingModel.collection.insertOne(row({ detector: 'lexical' }));

    await expect(DataLakeFindingModel.collection.insertOne(row({ detector: 'model' }))).resolves.toBeDefined();
  });
});
