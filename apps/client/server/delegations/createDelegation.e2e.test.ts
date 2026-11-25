import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryReplSet } from 'mongodb-memory-server';
import {
  createMongoReplSet,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../../../packages/database/src/__test__/createMongoServer';
import { DelegatedItemModel, FabFile } from '@bike4mind/database';
import { createDelegation } from './createDelegation';

const publish = vi.hoisted(() => vi.fn());
vi.mock('@bike4mind/server-utils/utils/eventBus', () => ({ DelegationEvents: { Process: { publish } } }));

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const OWNER = '650000000000000000000001';
const OTHER = '650000000000000000000002';
let database: MongoMemoryReplSet;

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
  publish.mockReset().mockResolvedValue(undefined);
  await FabFile.collection.deleteMany({});
  await DelegatedItemModel.collection.deleteMany({});
});

async function insertFile(userId: string, extra: Record<string, unknown> = {}) {
  const { insertedId } = await FabFile.collection.insertOne({ userId, fileName: 'deck.pdf', ...extra });
  return insertedId.toString();
}

it('stores and dispatches an item that references only the caller own live files', async () => {
  const own = await insertFile(OWNER);
  const blocked = await insertFile(OWNER, { moderationStatus: 'blocked' });

  const item = await createDelegation(OWNER, { intent: 'Summarize', file_ids: [own, blocked] });

  expect((await DelegatedItemModel.findById(item._id).lean())?.fileIds).toEqual([own, blocked]);
  expect(publish).toHaveBeenCalledWith(
    { delegationId: item._id.toString(), userId: OWNER },
    { requireAcceptance: true }
  );
});

it.each([
  ['another user file', () => insertFile(OTHER)],
  ['a deleted file', () => insertFile(OWNER, { deletedAt: new Date() })],
  ['a missing file', async () => new mongoose.Types.ObjectId().toString()],
  ['a malformed id', async () => 'not-an-object-id'],
])('404s %s and stores nothing', async (_label, arrange) => {
  const own = await insertFile(OWNER);
  const denied = await arrange();

  await expect(createDelegation(OWNER, { intent: 'Summarize', file_ids: [own, denied] })).rejects.toMatchObject({
    statusCode: 404,
  });
  expect(await DelegatedItemModel.countDocuments()).toBe(0);
  expect(publish).not.toHaveBeenCalled();
});
