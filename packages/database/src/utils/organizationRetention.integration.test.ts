import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import { withTransaction } from '@bike4mind/db-core';
import { User } from '../models/auth/UserModel';
import { OrganizationGeneratedObject } from '../models/infra/admin/OrganizationGeneratedObjectModel';
import { OrganizationRetentionEstimate } from '../models/infra/admin/OrganizationRetentionModel';
import { createMongoReplSet, settleAutoIndexBuilds, MONGO_TEST_TIMEOUT_MS } from '../__test__/createMongoServer';
import {
  ERASED_RETENTION_CREATOR,
  eraseOrganizationRetentionForUser,
  recordRetainedGeneratedObject,
} from './organizationRetention';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });
let database: Awaited<ReturnType<typeof createMongoReplSet>>;
const userId = 'abcdefabcdefabcdefabcdef';
const otherUserId = 'fedcbafedcbafedcbafedcba';
const organizationId = '123456781234567812345678';
const sessionId = '876543218765432187654321';
const key = '12345678-1234-1234-1234-123456789abc.png';
const input = { key, organizationId, sessionId, userId };

function barrier() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return {
    promise,
    release: () => {
      if (!resolve) throw new Error('Barrier was not initialized');
      resolve();
    },
  };
}
async function estimate(actorUserId = userId) {
  await OrganizationRetentionEstimate.create({
    token: randomUUID(),
    actorUserId,
    organizationId,
    version: 1,
    policy: { chats: 1, files: null, media: null },
    counts: { chats: 1, files: 0, media: 0 },
    estimatedAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
  });
}
async function erase() {
  await withTransaction(async session => {
    await eraseOrganizationRetentionForUser(userId, { session });
    await User.deleteOne({ _id: userId }, { session });
  });
}
beforeAll(async () => {
  database = await createMongoReplSet();
  await mongoose.connect(database.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  await OrganizationGeneratedObject.createIndexes();
  await OrganizationRetentionEstimate.createIndexes();
});
afterAll(async () => {
  await mongoose.disconnect();
  await database?.stop();
});
beforeEach(async () => {
  vi.restoreAllMocks();
  for (const model of [User, OrganizationGeneratedObject, OrganizationRetentionEstimate])
    await model.collection.deleteMany({});
  await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(userId), username: 'retention-creator' });
});

describe('organization retention metadata erasure over real transactions', () => {
  it('removes subject estimates and anonymizes immutable creator fields while retaining ownership and foreign controls', async () => {
    await User.collection.insertOne({ _id: new mongoose.Types.ObjectId(otherUserId), username: 'other-creator' });
    expect(await recordRetainedGeneratedObject(input)).toBe(true);
    const original = await OrganizationGeneratedObject.findOne({ key }).lean();
    await recordRetainedGeneratedObject({ ...input, key: 'foreign.png', userId: otherUserId });
    await estimate();
    await estimate(otherUserId);
    await erase();
    expect(await User.exists({ _id: userId })).toBeNull();
    expect(await OrganizationRetentionEstimate.countDocuments({ actorUserId: userId })).toBe(0);
    expect(await OrganizationRetentionEstimate.countDocuments({ actorUserId: otherUserId })).toBe(1);
    expect(await OrganizationGeneratedObject.findOne({ key }).lean()).toMatchObject({
      key,
      organizationId,
      sessionId,
      userId: ERASED_RETENTION_CREATOR,
      createdAt: original?.createdAt,
    });
    expect((await OrganizationGeneratedObject.findOne({ key: 'foreign.png' }).lean())?.userId).toBe(otherUserId);
    await eraseOrganizationRetentionForUser(userId);
    expect(await OrganizationGeneratedObject.countDocuments({ key })).toBe(1);
  });

  it('rolls raw immutable-field redaction and estimate deletion back with a failed User deletion transaction', async () => {
    await recordRetainedGeneratedObject(input);
    await estimate();
    await expect(
      withTransaction(async session => {
        await eraseOrganizationRetentionForUser(userId, { session });
        await User.deleteOne({ _id: userId }, { session });
        throw new Error('record write failed');
      })
    ).rejects.toThrow('record write failed');
    expect(await User.exists({ _id: userId })).not.toBeNull();
    expect((await OrganizationGeneratedObject.findOne({ key }).lean())?.userId).toBe(userId);
    expect(await OrganizationRetentionEstimate.countDocuments({ actorUserId: userId })).toBe(1);
  });

  it('keeps a late verified ownership record anonymous after deletion wins without recreating User', async () => {
    await erase();
    expect(await recordRetainedGeneratedObject(input)).toBe(false);
    expect(await User.countDocuments({})).toBe(0);
    expect(await OrganizationGeneratedObject.findOne({ key }).lean()).toMatchObject({
      key,
      organizationId,
      sessionId,
      userId: ERASED_RETENTION_CREATOR,
    });
  });

  it('uses the nested permanent purge fence before the User row is finally removed', async () => {
    await User.updateOne({ _id: userId }, { $set: { 'deletion.purgeStartedAt': new Date() } });
    expect(await recordRetainedGeneratedObject(input)).toBe(false);
    expect((await OrganizationGeneratedObject.findOne({ key }).lean())?.userId).toBe(ERASED_RETENTION_CREATOR);
    expect(await User.exists({ _id: userId })).not.toBeNull();
  });

  it('serializes a creator write that wins first with actual erasure and leaves no raw identifier after the retry', async () => {
    const locked = barrier();
    const continueWrite = barrier();
    const deletionReady = barrier();
    const update = User.collection.updateOne.bind(User.collection);
    vi.spyOn(User.collection, 'updateOne').mockImplementationOnce(async (...args) => {
      const result = await update(...args);
      locked.release();
      await continueWrite.promise;
      return result;
    });
    const writer = recordRetainedGeneratedObject(input);
    await locked.promise;
    const deletion = withTransaction(async session => {
      await eraseOrganizationRetentionForUser(userId, { session });
      deletionReady.release();
      await User.deleteOne({ _id: userId }, { session });
    });
    await deletionReady.promise;
    continueWrite.release();
    await Promise.all([writer, deletion]);
    expect(await User.exists({ _id: userId })).toBeNull();
    expect((await OrganizationGeneratedObject.findOne({ key }).lean())?.userId).toBe(ERASED_RETENTION_CREATOR);
  });
});
