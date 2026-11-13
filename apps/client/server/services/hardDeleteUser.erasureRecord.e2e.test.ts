import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ErasureRecordModel, FeedbackNoteModel, FeedbackModel, FeedbackAiModel, User } from '@bike4mind/database';
import { erasureIdHash } from '@bike4mind/server-utils/privacy/erasureHash';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.mock('@bike4mind/server-utils/utils/config', () => ({ Config: { JWT_SECRET: 'test-jwt-secret' } }));
vi.mock('@bike4mind/server-utils/analytics/signupEvents', () => ({ emitBillingEvent: vi.fn() }));
vi.mock('@bike4mind/server-utils/billing/cancelAccountSubscriptions', () => ({
  cancelAccountSubscriptions: vi.fn(async () => ({ canceled: [], failed: [] })),
  readAccountSubscriptionCustomerIds: vi.fn(async () => []),
  SINGLE_USER_CANCEL_BUDGET_MS: 1000,
  NO_SUBSCRIPTIONS_CANCELED: { canceled: [], failed: [] },
}));
vi.mock('@server/services/purgeDeletedUserData', () => ({
  readUserIntegrationGrants: vi.fn(async () => null),
  purgeDeletedUserData: vi.fn(),
}));

import { hardDeleteUser } from './hardDeleteUser';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: MongoMemoryReplSet;
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const userId = new mongoose.Types.ObjectId();
const id = String(userId);

beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  await User.collection.deleteMany({});
  await ErasureRecordModel.deleteMany({});
  await FeedbackNoteModel.deleteMany({});
  await FeedbackAiModel.deleteMany({});
  await FeedbackModel.deleteMany({});
  await User.collection.insertOne({ _id: userId, username: 'erase-me', email: 'erase-me@example.test' });
  const report = await FeedbackModel.create({ userId: id, username: 'Reporter', status: 'New' });
  await FeedbackAiModel.create({
    feedbackId: report.id,
    inputHash: 'hash',
    model: 'test-embedding',
    vector: [1],
    similar: [],
    reportCreatedAt: report.createdAt,
    expiresAt: new Date(Date.now() + 86400000),
  });
  await FeedbackNoteModel.create({
    feedbackId: String(new mongoose.Types.ObjectId()),
    userId: id,
    author: { id: 'admin', name: 'Admin' },
    body: 'Private note',
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + 86400000),
  });
});

const erase = (recordInTransaction?: () => Promise<void>) =>
  hardDeleteUser(id, { deletedBy: id, initiatedBy: 'self', logger, recordInTransaction }, users => users.delete(id));

describe('hardDeleteUser erasure record transaction', () => {
  it('commits the hash-only record with the delete', async () => {
    await erase();
    expect(await User.collection.countDocuments({ _id: userId })).toBe(0);
    expect(await FeedbackNoteModel.countDocuments()).toBe(0);
    expect(await FeedbackAiModel.countDocuments()).toBe(0);
    const records = await ErasureRecordModel.find().lean();
    expect(records).toHaveLength(1);
    expect(records[0].idHash).toBe(erasureIdHash(id));
    const stored = JSON.stringify(records[0]);
    expect(stored).not.toContain(id);
    expect(stored).not.toContain('erase-me');
  });

  it('rolls the record back with the delete when a later step throws', async () => {
    await expect(
      erase(async () => {
        throw new Error('audit failed');
      })
    ).rejects.toThrow('audit failed');
    expect(await User.collection.countDocuments({ _id: userId })).toBe(1);
    expect(await ErasureRecordModel.countDocuments()).toBe(0);
    expect(await FeedbackNoteModel.countDocuments()).toBe(1);
    expect(await FeedbackAiModel.countDocuments()).toBe(1);
  });
  it('keeps the user and erasure retry anchor when AI deletion fails, then retries', async () => {
    const failure = vi.spyOn(FeedbackAiModel, 'deleteMany').mockImplementationOnce(() => {
      throw new Error('AI cleanup failed');
    });
    try {
      await expect(erase()).rejects.toThrow('AI cleanup failed');
    } finally {
      failure.mockRestore();
    }
    expect(await User.collection.countDocuments({ _id: userId })).toBe(1);
    expect(await FeedbackAiModel.countDocuments()).toBe(1);
    expect(await ErasureRecordModel.countDocuments()).toBe(0);
    await erase();
    expect(await User.collection.countDocuments({ _id: userId })).toBe(0);
    expect(await FeedbackAiModel.countDocuments()).toBe(0);
    expect(await ErasureRecordModel.countDocuments()).toBe(1);
  });
});
