import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FeedbackModel, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// A core migration imported transitively via '@bike4mind/database' need not evaluate SST config,
// but mirror the sibling ensure-*-index tests' guard so this stays robust if that changes.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20260918000000_ensure-feedback-org-createdat-index';

// Boots a real mongod, so lift the whole file off the shard's unit-test budget for tests AND
// hooks in one place (see MONGO_TEST_TIMEOUT_MS for why 30s is not enough).
vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'feedback_org_createdAt';
const SUBJECT_INDEX_NAME = 'feedback_org_subject_createdAt';
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
  await mongoose.connection.db?.createCollection(FeedbackModel.collection.collectionName).catch(() => {});
  await FeedbackModel.collection.deleteMany({});
  // Ensure the index is absent before each test (autoIndex may have built it on connect).
  await safeDropIndex(FeedbackModel.collection, INDEX_NAME);
});

// Real mongod, not mocks: the migration's job is entirely index-build side effects, which a
// mocked collection can't verify.
describe('ensure-feedback-org-createdAt-index migration (real DB)', () => {
  it('builds the org + createdAt index the org report matches on', async () => {
    let idx = (await FeedbackModel.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeUndefined();

    await migration.up();

    idx = (await FeedbackModel.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
    // Key ORDER is the point: organizationId first so createdAt keeps a range bound.
    expect(idx?.key).toEqual({ organizationId: 1, createdAt: -1 });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    const idx = (await FeedbackModel.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx).toBeDefined();
  });

  it('is the index the planner picks for an org + date-range read, over the subject compound', async () => {
    // The key-order assertion above says the index exists in the right shape; it says nothing about
    // the report actually landing on it rather than on feedback_org_subject_createdAt, which would
    // serve the same read behind a blocking sort.
    await migration.up();
    const subjects = ['product', 'session', 'turn'];
    await FeedbackModel.collection.insertMany(
      Array.from({ length: 90 }, (_, i) => ({
        userId: `u${i}`,
        username: `user${i}`,
        status: 'New',
        subject: subjects[i % subjects.length],
        organizationId: ORG_ID,
        contentStored: false,
        createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
        updatedAt: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
      }))
    );

    const plan = await FeedbackModel.collection
      .find({
        organizationId: ORG_ID,
        createdAt: { $gte: new Date(Date.UTC(2026, 0, 5)), $lt: new Date(Date.UTC(2026, 0, 20)) },
      })
      .sort({ createdAt: -1 })
      .explain('queryPlanner');

    // Serialized rather than walked: the winning plan's stage nesting differs across server
    // versions, and the only claim here is which index it settled on.
    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    expect(winning).toContain(INDEX_NAME);
    expect(winning).not.toContain(SUBJECT_INDEX_NAME);
  });
});
