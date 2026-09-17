import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FeedbackModel, safeDropIndex } from '@bike4mind/database';
import { FeedbackStatus } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-*-index tests' guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260916000000_ensure-feedback-helpcontext-index';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'feedback_helpContext_eventId';

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
  await mongoose.connection.db?.createCollection(FeedbackModel.collection.collectionName).catch(() => {});
  await FeedbackModel.collection.deleteMany({});
  // Ensure the index is absent before each test (autoIndex may have built it on connect).
  await safeDropIndex(FeedbackModel.collection, INDEX_NAME);
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a
// mocked collection can't verify.
describe('ensure-feedback-helpcontext-index migration (real DB)', () => {
  it('builds the unique partial index the help router serializes its find-or-create on', async () => {
    let idx = (await FeedbackModel.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await FeedbackModel.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
    expect(idx?.key).toEqual({ 'helpContext.eventId': 1 });
    // Unique is the whole point - it is the only thing that collapses two concurrent submissions
    // for one help event into one report.
    expect(idx?.unique).toBe(true);
    // partialFilterExpression, not sparse: sparse would index every non-help report under a null
    // key and collide them all against each other.
    expect(idx?.partialFilterExpression).toEqual({ 'helpContext.eventId': { $exists: true } });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await FeedbackModel.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });

  /**
   * The constraint has to bite for reports that carry a help context and stay out of the way of
   * every report that does not - otherwise the migration "succeeded" while either the router's
   * race is still open or ordinary product feedback can no longer be filed at all.
   */
  it('rejects a second report for one help event while leaving non-help reports alone', async () => {
    await migration.up();

    const helpReport = {
      userId: 'u1',
      status: FeedbackStatus.New,
      username: 'reader',
      subject: 'help',
      contentStored: true,
      helpContext: { eventId: 'event-1', surface: 'article' as const, slug: 'a' },
    };
    await FeedbackModel.create(helpReport);
    await expect(FeedbackModel.create({ ...helpReport, userId: 'u2' })).rejects.toThrow(/E11000/);

    const plain = {
      userId: 'u3',
      status: FeedbackStatus.New,
      username: 'reader',
      subject: 'product' as const,
      contentStored: false,
    };
    await FeedbackModel.create(plain);
    await expect(FeedbackModel.create({ ...plain, userId: 'u4' })).resolves.toBeDefined();
  });
});
