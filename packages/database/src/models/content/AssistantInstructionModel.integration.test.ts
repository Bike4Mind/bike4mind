import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  createMongoReplSet,
  createMongoServer,
  settleAutoIndexBuilds,
  MONGO_TEST_TIMEOUT_MS,
} from '../../__test__/createMongoServer';
import { AssistantInstructionModel, assistantInstructionRepository as repo } from './AssistantInstructionModel';
import { User } from '../auth/UserModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

const countByUser = (userId: string) => AssistantInstructionModel.countDocuments({ userId });
const seed = async (input: { userId: string; text: string }) =>
  (await AssistantInstructionModel.create(input)).toObject();

let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await server.stop();
});

const userId = 'abcdefabcdefabcdefabcdef';
const otherUserId = 'fedcbafedcbafedcbafedcba';

beforeEach(async () => {
  vi.restoreAllMocks();
  await User.collection.deleteMany({});
  await User.collection.insertMany([
    { _id: new mongoose.Types.ObjectId(userId), username: 'instructions-owner', __v: 0 },
    { _id: new mongoose.Types.ObjectId(otherUserId), username: 'instructions-other', __v: 0 },
  ]);
});

afterEach(async () => {
  await AssistantInstructionModel.deleteMany({});
});

describe('assistantInstructionRepository', () => {
  it('lists only the owner instructions, oldest first, and counts them', async () => {
    await seed({ userId, text: 'first' });
    await seed({ userId: otherUserId, text: 'someone else' });
    await seed({ userId, text: 'second' });

    const listed = await repo.listByUser(userId);
    expect(listed.map(i => i.text)).toEqual(['first', 'second']);
    expect(await countByUser(userId)).toBe(2);
    expect(await countByUser('nobody')).toBe(0);
  });

  it('deletes an owned instruction and reports it', async () => {
    const created = await seed({ userId, text: 'drop me' });
    expect(await repo.deleteOwned(userId.toUpperCase(), created._id.toString())).toBe(true);
    expect(await countByUser(userId)).toBe(0);
  });

  it('leaves another user instruction in place and reports it missing', async () => {
    const created = await seed({ userId, text: 'mine' });
    expect(await repo.deleteOwned(otherUserId, created._id.toString())).toBe(false);
    expect(await countByUser(userId)).toBe(1);
  });

  it('treats a malformed or unknown id as missing without throwing', async () => {
    expect(await repo.deleteOwned(userId, 'not-an-id')).toBe(false);
    expect(await repo.deleteOwned(userId, new mongoose.Types.ObjectId().toString())).toBe(false);
  });

  it('refuses a save at the cap and lists every stored row', async () => {
    for (let i = 0; i < 3; i++) expect(await repo.createWithinCap({ userId, text: `rule-${i}` }, 3)).not.toBeNull();
    expect(await repo.createWithinCap({ userId, text: 'one more' }, 3)).toBeNull();
    expect(await repo.createWithinCap({ userId: otherUserId, text: 'other user' }, 3)).not.toBeNull();
    expect((await repo.listByUser(userId)).map(i => i.text)).toEqual(['rule-0', 'rule-1', 'rule-2']);
  });

  it('gives the last slot to exactly one of several racing saves', async () => {
    for (let i = 0; i < 19; i++) await seed({ userId, text: `rule-${i}` });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => repo.createWithinCap({ userId, text: `race-${i}` }, 20))
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await countByUser(userId)).toBe(20);
    expect(await repo.listByUser(userId)).toHaveLength(20);
  });

  it('rejects text over the length cap at the model', async () => {
    await expect(seed({ userId, text: 'x'.repeat(281) })).rejects.toThrow();
  });

  it('canonicalizes the owner before cap counting and insertion', async () => {
    expect(await repo.createWithinCap({ userId: userId.toUpperCase(), text: 'first' }, 1)).not.toBeNull();
    expect(await repo.createWithinCap({ userId, text: 'second' }, 1)).toBeNull();
    expect((await repo.listByUser(userId)).map(row => row.text)).toEqual(['first']);
    expect((await repo.listByUser(userId.toUpperCase())).map(row => row.text)).toEqual(['first']);
    expect(await countByUser(userId.toUpperCase())).toBe(0);
  });

  it('refuses admission after the permanent purge marker, even while the User still exists', async () => {
    await User.updateOne({ _id: userId }, { $set: { 'deletion.purgeStartedAt': new Date() } });
    await expect(repo.createWithinCap({ userId, text: 'late private text' }, 20)).rejects.toThrow(
      'Account unavailable'
    );
    expect(await User.exists({ _id: userId })).not.toBeNull();
    expect(await countByUser(userId)).toBe(0);
    expect(await repo.createWithinCap({ userId: otherUserId, text: 'foreign control' }, 20)).not.toBeNull();
  });

  it('does not recreate instruction text after the User is deleted', async () => {
    await User.deleteOne({ _id: userId });
    await expect(repo.createWithinCap({ userId, text: 'late private text' }, 20)).rejects.toThrow(
      'Account unavailable'
    );
    expect(await countByUser(userId)).toBe(0);
    expect(await User.exists({ _id: userId })).toBeNull();
  });

  it('rolls an actual insert and the User fence back when the insert acknowledgement fails', async () => {
    const originalUser = await User.findById(userId).lean();
    const insert = AssistantInstructionModel.collection.insertOne.bind(AssistantInstructionModel.collection);
    vi.spyOn(AssistantInstructionModel.collection, 'insertOne').mockImplementationOnce(async (...args) => {
      await insert(...args);
      throw new Error('insert acknowledgement failed');
    });
    await expect(repo.createWithinCap({ userId, text: 'must roll back' }, 20)).rejects.toThrow(
      'insert acknowledgement failed'
    );
    expect(await countByUser(userId)).toBe(0);
    expect(await User.findById(userId).lean()).toEqual(originalUser);
  });

  it('rejects unsupported standalone transactions without falling back to an insert', async () => {
    const standalone = await createMongoServer();
    await mongoose.disconnect();
    try {
      await mongoose.connect(standalone.getUri(), { autoIndex: false });
      await settleAutoIndexBuilds(mongoose);
      await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(userId), username: 'standalone-owner' });
      await expect(repo.createWithinCap({ userId, text: 'must not fall back' }, 20)).rejects.toThrow(
        /Transaction numbers are only allowed/
      );
      expect(await countByUser(userId)).toBe(0);
    } finally {
      await mongoose.disconnect();
      await standalone.stop();
      await mongoose.connect(server.getUri(), { autoIndex: false });
      await settleAutoIndexBuilds(mongoose);
    }
  });
});
