import { withTransaction } from '@bike4mind/db-core';
import mongoose, { Types } from 'mongoose';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createMongoReplSet, settleAutoIndexBuilds } from '../../__test__/createMongoServer';
import User from '../auth/UserModel';
import { Connection } from './ConnectionModel';
import { QuerySubscription } from './QuerySubscriptionModel';
import { realtimeConnectionRepository } from './realtimeConnectionRepository';

/**
 * endConnections is called by revoke primitives that may run inside withTransaction (e.g.
 * commitWithSessionEnd in apps/client/server/auth/endUserSessions.ts). It must never join that
 * transaction. Needs a real replica set: a standalone mongod cannot run transactions, so it cannot
 * tell a write that joins the ambient session from one that stays outside it.
 */

let server: Awaited<ReturnType<typeof createMongoReplSet>>;

beforeAll(async () => {
  server = await createMongoReplSet();
  await mongoose.connect(server.getUri(), { autoIndex: false });
  await settleAutoIndexBuilds(mongoose);
  // Collections cannot be created implicitly inside a transaction on every server version.
  await Promise.all([User.createCollection(), Connection.createCollection(), QuerySubscription.createCollection()]);
}, 60000);

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
}, 60000);

afterEach(async () => {
  await Promise.all([
    User.collection.deleteMany({}),
    Connection.collection.deleteMany({}),
    QuerySubscription.collection.deleteMany({}),
  ]);
});

const USER_ID = new Types.ObjectId();

async function seed(subscribers: unknown) {
  await User.collection.insertOne({ _id: USER_ID, tokenVersion: 0 });
  await Connection.collection.insertOne({ connectionId: 'c1', userId: USER_ID.toHexString(), createdAt: new Date() });
  await QuerySubscription.collection.insertOne({
    collectionName: 'quests',
    queryId: 'q1',
    query: {},
    fields: {},
    subscribers,
  });
}

const bumpTokenVersion = () => User.updateOne({ _id: USER_ID }, { $inc: { tokenVersion: 1 } });
const tokenVersion = async () => (await User.collection.findOne({ _id: USER_ID }))?.tokenVersion;
const endedAt = async () => (await Connection.collection.findOne({ connectionId: 'c1' }))?.endedAt;

describe('realtimeConnectionRepository.endConnections inside withTransaction', () => {
  it('is not rolled back with the caller transaction', async () => {
    await seed([{ endpoint: 'https://ws.example.com/test', connectionId: 'c1', clientId: 'x', attempts: 0 }]);

    await expect(
      withTransaction(async () => {
        await bumpTokenVersion();
        await realtimeConnectionRepository.endConnections({ userId: USER_ID.toHexString() });
        throw new Error('force abort');
      })
    ).rejects.toThrow('force abort');

    expect(await tokenVersion()).toBe(0);
    expect(await endedAt()).toBeInstanceOf(Date);
    expect(await QuerySubscription.collection.countDocuments({})).toBe(0);
  });

  it('does not abort the caller transaction when a prune write fails on the server', async () => {
    // A non-array `subscribers` still matches the dotted lookup, so the $pull itself fails server-side.
    await seed({ endpoint: 'https://ws.example.com/test', connectionId: 'c1', clientId: 'x', attempts: 0 });

    let pruneError: unknown;
    await withTransaction(async () => {
      await bumpTokenVersion();
      // Caught like endRealtimeConnections does; the transaction carries on.
      await realtimeConnectionRepository.endConnections({ userId: USER_ID.toHexString() }).catch(error => {
        pruneError = error;
      });
    });

    expect(pruneError).toBeDefined();
    expect(await tokenVersion()).toBe(1);
    // A prune that joined the transaction aborts it and the commit retries until the default 60s.
  }, 20000);
});
