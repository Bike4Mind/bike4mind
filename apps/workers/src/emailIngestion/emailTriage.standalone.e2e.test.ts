import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { User, IngestedEmailModel, EmailTriageItemModel, emailTriageItemRepository } from '@bike4mind/database';
import {
  createMongoServer,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoServer>>;
beforeAll(async () => {
  database = await createMongoServer();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});

it('fails without a transactional database instead of falling back to an unfenced insert', async () => {
  const userId = new mongoose.Types.ObjectId().toString();
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(userId) });
  const email = await IngestedEmailModel.create({
    userId,
    messageId: 'standalone',
    threadId: 'thread',
    from: 'sender@example.com',
    to: ['owner@example.com'],
    subject: 'Renewal',
    date: new Date(),
    receivedAt: new Date(),
  });
  await expect(
    emailTriageItemRepository.storeForLiveEmail({
      userId,
      emailId: email._id.toString(),
      kind: 'fyi',
      summary: 'Must not be stored outside a transaction',
      model: null,
      tokensUsed: null,
    })
  ).rejects.toMatchObject({ code: 20 });
  expect(await EmailTriageItemModel.countDocuments()).toBe(0);
});
