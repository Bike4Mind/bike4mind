import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { User } from '../auth/UserModel';
import { PLATFORM_END_USER_SEEN_REFRESH_MS, PlatformEndUser, platformEndUserRepository } from './PlatformEndUserModel';
import { createMongoReplSet, settleAutoIndexBuilds, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;

const DIGEST = 'ab'.repeat(32);
const input = {
  providerEndUserId: DIGEST,
  keyOwnerId: 'abcdefabcdefabcdefabcdef',
  apiKeyId: 'key-1',
  endUserId: 'customer_42',
};

describe('platformEndUserRepository', () => {
  beforeAll(async () => {
    database = await createMongoReplSet();
    await mongoose.connect(database.getUri(), { autoIndex: false });
    await settleAutoIndexBuilds(mongoose);
    await PlatformEndUser.createIndexes();
  });
  afterAll(async () => {
    await mongoose.disconnect();
    await database?.stop();
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await PlatformEndUser.deleteMany({});
    await User.collection.deleteMany({});
    await User.collection.insertOne({
      _id: new mongoose.Types.ObjectId(input.keyOwnerId),
      username: 'platform-owner',
      __v: 0,
    });
  });

  it('creates the row the first time an end user is seen', async () => {
    const now = new Date('2026-11-01T00:00:00Z');
    await platformEndUserRepository.recordSeen(input, now);

    const row = await platformEndUserRepository.findByProviderEndUserId(DIGEST);
    expect(row).toMatchObject({ ...input, firstSeenAt: now, lastSeenAt: now });
  });

  it('leaves a fresh row alone and refreshes a stale one, keeping firstSeenAt', async () => {
    const first = new Date('2026-11-01T00:00:00Z');
    await platformEndUserRepository.recordSeen(input, first);

    await platformEndUserRepository.recordSeen(input, new Date(first.getTime() + 60_000));
    expect(await platformEndUserRepository.findByProviderEndUserId(DIGEST)).toMatchObject({
      apiKeyId: 'key-1',
      lastSeenAt: first,
    });

    const later = new Date(first.getTime() + PLATFORM_END_USER_SEEN_REFRESH_MS + 1);
    await platformEndUserRepository.recordSeen({ ...input, apiKeyId: 'key-2' }, later);
    expect(await platformEndUserRepository.findByProviderEndUserId(DIGEST)).toMatchObject({
      apiKeyId: 'key-2',
      firstSeenAt: first,
      lastSeenAt: later,
    });
    expect(await PlatformEndUser.countDocuments()).toBe(1);
  });

  it('refreshes the key on a fresh row when a different key sends the end user', async () => {
    const first = new Date('2026-11-01T00:00:00Z');
    await platformEndUserRepository.recordSeen(input, first);

    const soon = new Date(first.getTime() + 60_000);
    await platformEndUserRepository.recordSeen({ ...input, apiKeyId: 'key-2' }, soon);
    expect(await platformEndUserRepository.findByProviderEndUserId(DIGEST)).toMatchObject({
      apiKeyId: 'key-2',
      firstSeenAt: first,
      lastSeenAt: soon,
    });

    await platformEndUserRepository.recordSeen({ ...input, apiKeyId: 'key-2' }, new Date(soon.getTime() + 60_000));
    expect((await platformEndUserRepository.findByProviderEndUserId(DIGEST))?.lastSeenAt).toEqual(soon);
    expect(await PlatformEndUser.countDocuments()).toBe(1);
  });

  it('answers null for an unknown identifier', async () => {
    expect(await platformEndUserRepository.findByProviderEndUserId('cd'.repeat(32))).toBeNull();
  });
  it('does not create metadata for an absent owner', async () => {
    await User.collection.deleteOne({ _id: new mongoose.Types.ObjectId(input.keyOwnerId) });
    await platformEndUserRepository.recordSeen(input);
    expect(await PlatformEndUser.countDocuments()).toBe(0);
  });

  it('does not create metadata after the permanent purge marker is set', async () => {
    await User.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(input.keyOwnerId) },
      { $set: { 'deletion.purgeStartedAt': new Date() } }
    );
    await platformEndUserRepository.recordSeen(input);
    expect(await PlatformEndUser.countDocuments()).toBe(0);
  });

  it('rolls back its owner write on a duplicate fresh row or a metadata failure', async () => {
    await platformEndUserRepository.recordSeen(input);
    const before = await User.findById(input.keyOwnerId).lean();
    await platformEndUserRepository.recordSeen(input);
    expect((await User.findById(input.keyOwnerId).lean())?.__v).toBe(before?.__v);
    const error = new Error('metadata write unavailable');
    const failure = vi.spyOn(PlatformEndUser, 'updateOne').mockImplementationOnce(() => {
      throw error;
    });
    try {
      await expect(platformEndUserRepository.recordSeen({ ...input, apiKeyId: 'key-2' })).rejects.toBe(error);
    } finally {
      failure.mockRestore();
    }
    expect((await User.findById(input.keyOwnerId).lean())?.__v).toBe(before?.__v);
    expect((await platformEndUserRepository.findByProviderEndUserId(DIGEST))?.apiKeyId).toBe('key-1');
    await platformEndUserRepository.recordSeen({ ...input, apiKeyId: 'key-2' });
    expect((await platformEndUserRepository.findByProviderEndUserId(DIGEST))?.apiKeyId).toBe('key-2');
  });
});
