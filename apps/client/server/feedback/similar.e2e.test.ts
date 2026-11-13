import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { FeedbackModel, FeedbackTextModel } from '@bike4mind/database';
import { FeedbackStatus } from '@bike4mind/common';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';
import { getSimilarFeedback } from './similar';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let mongo: MongoMemoryServer;
beforeAll(async () => {
  mongo = await createMongoServer();
  await mongoose.connect(mongo.getUri(), { autoIndex: false });
  await FeedbackModel.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

it('finds near-identical retained reports of the same type within 14 days without AI records', async () => {
  const now = new Date();
  const content = 'The chat response stops streaming after I attach a file.';
  const create = async (
    options: { days?: number; type?: string; status?: FeedbackStatus; expired?: boolean; text?: string } = {}
  ) => {
    const createdAt = new Date(now.getTime() - (options.days ?? 0) * 86400000);
    const doc = await FeedbackModel.create({
      userId: 'reporter',
      username: 'reporter',
      subject: 'product',
      type: options.type ?? 'Bug',
      status: options.status ?? FeedbackStatus.New,
      contentStored: true,
      createdAt,
    });
    await FeedbackTextModel.create({
      _id: doc._id,
      content: options.text ?? content,
      expiresAt: new Date(now.getTime() + (options.expired ? -1 : 1) * 86400000),
    });
    return doc;
  };
  const source = await create();
  const closed = await create({ days: 1, status: FeedbackStatus.Closed });
  const open = await create({ days: 2, text: content.replace('a file', 'my file') });
  await create({ days: 15 });
  await create({ type: 'Feature' });
  await create({ expired: true });
  await create({ text: 'Please add custom themes to the profile settings' });
  const audit = vi.fn().mockResolvedValue(undefined);
  const result = await getSimilarFeedback(source.id, { canRead: () => true, audit, now });
  expect(result.items.map(item => item.id)).toEqual([open.id, closed.id]);
  expect(result.limited).toBe(false);
  expect(audit).toHaveBeenCalledWith([source, open, closed].map(doc => ({ id: doc.id, userId: doc.userId })));
});
