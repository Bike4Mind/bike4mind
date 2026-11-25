import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { User } from '../models/auth/UserModel';
import { FeedbackModel } from '../models/social/FeedbackModel';
import { FeedbackAiModel } from '../models/social/FeedbackAiModel';
import { deleteFeedbackAiForUser } from './feedbackAi';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let mongo: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});
beforeEach(async () => {
  await Promise.all([
    User.collection.deleteMany({}),
    FeedbackModel.collection.deleteMany({}),
    FeedbackAiModel.collection.deleteMany({}),
  ]);
});

const seed = async () => {
  const owner = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();
  await User.collection.insertMany([
    { _id: owner, username: 'owner', email: 'owner@example.test' },
    { _id: other, username: 'other', email: 'other@example.test' },
  ]);
  const reports = [
    ...Array.from({ length: 501 }, () => ({ _id: new mongoose.Types.ObjectId(), userId: String(owner) })),
    { _id: new mongoose.Types.ObjectId(), userId: String(owner).toUpperCase() },
    { _id: new mongoose.Types.ObjectId(), userEmail: 'owner@example.test' },
    { _id: new mongoose.Types.ObjectId(), userId: String(other), userEmail: 'owner@example.test' },
    { _id: new mongoose.Types.ObjectId(), userId: String(other) },
  ];
  await FeedbackModel.collection.insertMany(reports);
  await FeedbackAiModel.collection.insertMany(
    reports.map(report => ({
      feedbackId: String(report._id),
      inputHash: 'hash',
      model: 'test-embedding',
      vector: [1],
      similar: [],
      reportCreatedAt: new Date(),
      expiresAt: new Date(Date.now() + 86400000),
    }))
  );
  return { owner: String(owner), preserved: reports.slice(-2).map(report => String(report._id)) };
};
describe('feedback AI reporter cleanup', () => {
  it('deletes every bounded batch and legacy parent relation without touching another reporter', async () => {
    const { owner, preserved } = await seed();
    await deleteFeedbackAiForUser(owner);
    expect((await FeedbackAiModel.find().lean()).map(row => row.feedbackId).sort()).toEqual(preserved.sort());
    expect(await FeedbackModel.countDocuments()).toBe(505);
    expect(await User.countDocuments()).toBe(2);
  });
  it('propagates a lost purge lease and can retry without retaining derived bytes', async () => {
    const { owner, preserved } = await seed();
    await expect(
      deleteFeedbackAiForUser(owner, {
        assertLease: async () => {
          throw new Error('lease lost');
        },
      })
    ).rejects.toThrow('lease lost');
    expect(await FeedbackAiModel.countDocuments()).toBe(505);
    await deleteFeedbackAiForUser(owner);
    expect((await FeedbackAiModel.find().lean()).map(row => row.feedbackId).sort()).toEqual(preserved.sort());
  });
});
