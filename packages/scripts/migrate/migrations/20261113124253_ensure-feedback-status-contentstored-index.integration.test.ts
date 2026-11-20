import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import mongoose from 'mongoose';
import { FeedbackModel, safeDropIndex } from '@bike4mind/database';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../database/src/__test__/createMongoServer';

// Mirrors the sibling ensure-*-index tests' guard against SST config evaluation.
vi.mock('../../utils/config', () => ({ Config: {} }));

import migration from './20261113124253_ensure-feedback-status-contentstored-index';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const INDEX_NAME = 'feedback_status_contentStored_createdAt';

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
  await mongoose.connection.db?.createCollection(FeedbackModel.collection.collectionName).catch(() => {});
  await FeedbackModel.collection.deleteMany({});
  await safeDropIndex(FeedbackModel.collection, INDEX_NAME);
});

describe('ensure-feedback-status-contentStored-index migration (real DB)', () => {
  it('builds the status + contentStored + createdAt index', async () => {
    expect((await FeedbackModel.collection.indexes()).find(i => i.name === INDEX_NAME)).toBeUndefined();

    await migration.up();

    const idx = (await FeedbackModel.collection.indexes()).find(i => i.name === INDEX_NAME);
    expect(idx?.key).toEqual({ status: 1, contentStored: 1, createdAt: -1 });
  });

  it('is idempotent on re-run', async () => {
    await migration.up();
    await migration.up();

    expect((await FeedbackModel.collection.indexes()).find(i => i.name === INDEX_NAME)).toBeDefined();
  });

  it('is the index the planner picks for a has-comment read over a date range', async () => {
    await migration.up();
    await FeedbackModel.collection.insertMany(
      Array.from({ length: 90 }, (_, i) => ({
        userId: `u${i}`,
        username: `user${i}`,
        status: i % 3 === 0 ? 'Closed' : 'New',
        subject: 'product',
        contentStored: i % 2 === 0,
        createdAt: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
        updatedAt: new Date(Date.UTC(2026, 0, 1 + (i % 28))),
      }))
    );

    const plan = await FeedbackModel.collection
      .find({
        status: { $in: ['New'] },
        contentStored: true,
        createdAt: { $gte: new Date(Date.UTC(2026, 0, 5)), $lte: new Date(Date.UTC(2026, 0, 20)) },
      })
      .sort({ createdAt: -1 })
      .explain('queryPlanner');

    expect(JSON.stringify(plan.queryPlanner.winningPlan)).toContain(INDEX_NAME);
  });
});
