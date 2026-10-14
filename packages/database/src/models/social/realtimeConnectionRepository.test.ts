import { ApiKeyStatus } from '@bike4mind/common';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { AuthSessionModel } from '../auth/AuthSessionModel';
import { UserApiKey } from '../auth/UserApiKeyModel';
import User from '../auth/UserModel';
import { Connection } from './ConnectionModel';
import { QuerySubscription } from './QuerySubscriptionModel';
import { REALTIME_CONNECTION_MAX_LIFETIME_MS, realtimeConnectionRepository } from './realtimeConnectionRepository';

setupMongoTest();

const NOW = new Date('2026-10-14T12:00:00.000Z');
const GRACE_MS = 2 * 60_000;
const minutes = (count: number) => count * 60_000;
const at = (offsetMs: number) => new Date(NOW.getTime() + offsetMs);

const USER_A = new Types.ObjectId().toHexString();
const USER_B = new Types.ObjectId().toHexString();

// Raw inserts: the sweep reads lean projections, so only the fields it reads matter.
async function insertUser(id: string, fields: Record<string, unknown> = {}) {
  await User.collection.insertOne({ _id: new Types.ObjectId(id), tokenVersion: 0, ...fields });
}

async function insertSession(sid: string, fields: Record<string, unknown> = {}) {
  await AuthSessionModel.collection.insertOne({ sid, userId: USER_A, expiresAt: at(minutes(60)), ...fields });
}

async function insertApiKey(fields: Record<string, unknown> = {}): Promise<string> {
  const id = new Types.ObjectId();
  await UserApiKey.collection.insertOne({ _id: id, userId: USER_A, status: ApiKeyStatus.ACTIVE, ...fields });
  return id.toHexString();
}

async function insertConnection(connectionId: string, fields: Record<string, unknown> = {}) {
  await Connection.collection.insertOne({
    connectionId,
    userId: USER_A,
    tokenVersion: 0,
    authExpiresAt: at(minutes(30)),
    createdAt: NOW,
    ...fields,
  });
}

async function insertSubscription(queryId: string, connectionIds: string[]) {
  await QuerySubscription.collection.insertOne({
    collectionName: 'quests',
    queryId,
    query: {},
    fields: {},
    subscribers: connectionIds.map(connectionId => ({
      endpoint: 'https://ws.example.com/test',
      connectionId,
      clientId: `client-${connectionId}`,
      attempts: 0,
    })),
  });
}

const connectionIds = async () => (await Connection.find({}).distinct('connectionId')).sort();
const subscriberIds = async (queryId: string) => {
  const doc = await QuerySubscription.findOne({ queryId }).lean();
  return doc ? doc.subscribers.map(subscriber => subscriber.connectionId).sort() : null;
};

describe('realtimeConnectionRepository.endConnections', () => {
  it("ends all of a user's connections and leaves other users' alone", async () => {
    await insertConnection('a1', { sid: 's1' });
    await insertConnection('a2', { apiKeyId: 'k1' });
    await insertConnection('b1', { userId: USER_B });

    const result = await realtimeConnectionRepository.endConnections({ userId: USER_A });

    expect(result.connectionIds.sort()).toEqual(['a1', 'a2']);
    expect(await connectionIds()).toEqual(['b1']);
  });

  it('ends only the named session, by sid', async () => {
    await insertConnection('a1', { sid: 's1' });
    await insertConnection('a2', { sid: 's2' });

    await realtimeConnectionRepository.endConnections({ sid: 's1' });

    expect(await connectionIds()).toEqual(['a2']);
  });

  it('keeps the excepted session and API-key connections with exceptSid + sessionsOnly', async () => {
    await insertConnection('keep', { sid: 's-current' });
    await insertConnection('other', { sid: 's-other' });
    await insertConnection('legacy');
    await insertConnection('key', { apiKeyId: 'k1' });

    await realtimeConnectionRepository.endConnections({
      userId: USER_A,
      exceptSid: 's-current',
      sessionsOnly: true,
    });

    expect(await connectionIds()).toEqual(['keep', 'key']);
  });

  it('ends an API key connections by apiKeyId', async () => {
    await insertConnection('key-1', { apiKeyId: 'k1' });
    await insertConnection('key-2', { apiKeyId: 'k2' });

    await realtimeConnectionRepository.endConnections({ apiKeyId: 'k1' });

    expect(await connectionIds()).toEqual(['key-2']);
  });

  it("pulls the ended connections from a shared subscription and keeps other users' subscribers", async () => {
    await insertConnection('a1');
    await insertConnection('b1', { userId: USER_B });
    await insertSubscription('shared', ['a1', 'b1']);
    await insertSubscription('only-a', ['a1']);

    await realtimeConnectionRepository.endConnections({ connectionIds: ['a1'] });

    expect(await subscriberIds('shared')).toEqual(['b1']);
    // A doc left with no subscribers is removed, as unsubscribe does.
    expect(await subscriberIds('only-a')).toBeNull();
    expect(await connectionIds()).toEqual(['b1']);
  });

  it('is a no-op when nothing matches', async () => {
    await insertConnection('a1');
    await insertSubscription('q', ['a1']);

    expect(await realtimeConnectionRepository.endConnections({ sid: 'missing' })).toEqual({ connectionIds: [] });
    expect(await subscriberIds('q')).toEqual(['a1']);
  });
});

describe('realtimeConnectionRepository.reauthenticate', () => {
  it('re-stamps the connection and drops only its subscriptions', async () => {
    await insertConnection('a1', { sid: 's1', tokenVersion: 0 });
    await insertConnection('b1', { userId: USER_B });
    await insertSubscription('shared', ['a1', 'b1']);
    const authExpiresAt = at(minutes(60));

    const updated = await realtimeConnectionRepository.reauthenticate('a1', { tokenVersion: 1, authExpiresAt });

    expect(updated).toBe(true);
    const row = await Connection.findOne({ connectionId: 'a1' }).lean();
    expect(row).toMatchObject({ tokenVersion: 1, authExpiresAt, sid: 's1' });
    expect(await subscriberIds('shared')).toEqual(['b1']);
  });

  it('returns false when the connection row is gone', async () => {
    expect(await realtimeConnectionRepository.reauthenticate('missing', { tokenVersion: 0, authExpiresAt: NOW })).toBe(
      false
    );
  });
});

describe('realtimeConnectionRepository.findSweepTargets', () => {
  const sweep = (batchSize?: number) =>
    realtimeConnectionRepository.findSweepTargets({
      now: NOW,
      graceMs: GRACE_MS,
      isAccountBlocked: user => !!user.isBanned,
      batchSize,
    });

  it('flags each lapsed credential with its reason and leaves healthy connections', async () => {
    await insertUser(USER_A, { tokenVersion: 2 });
    await insertUser(USER_B, { isBanned: true });
    await insertSession('s-live');
    await insertSession('s-revoked', { revokedAt: at(-minutes(1)) });
    await insertSession('s-expired', { expiresAt: at(-minutes(1)) });
    const liveKey = await insertApiKey();
    const disabledKey = await insertApiKey({ status: ApiKeyStatus.DISABLED });

    await insertConnection('healthy', { sid: 's-live', tokenVersion: 2 });
    await insertConnection('in-grace', { sid: 's-live', tokenVersion: 2, authExpiresAt: at(-minutes(1)) });
    await insertConnection('expired', { sid: 's-live', tokenVersion: 2, authExpiresAt: at(-minutes(3)) });
    await insertConnection('stale-version', { sid: 's-live', tokenVersion: 1 });
    await insertConnection('revoked-session', { sid: 's-revoked', tokenVersion: 2 });
    await insertConnection('expired-session', { sid: 's-expired', tokenVersion: 2 });
    await insertConnection('banned', { userId: USER_B });
    await insertConnection('user-missing', { userId: new Types.ObjectId().toHexString() });
    await insertConnection('live-key', { apiKeyId: liveKey, tokenVersion: undefined });
    await insertConnection('disabled-key', { apiKeyId: disabledKey, tokenVersion: undefined });
    await insertConnection('legacy-old', {
      tokenVersion: undefined,
      authExpiresAt: undefined,
      createdAt: at(-REALTIME_CONNECTION_MAX_LIFETIME_MS - minutes(3)),
    });
    await insertConnection('legacy-recent', {
      tokenVersion: undefined,
      authExpiresAt: undefined,
      createdAt: at(-minutes(30)),
    });

    // A small batch size walks several pages.
    const targets = await sweep(3);

    expect(Object.fromEntries(targets.map(target => [target.connectionId, target.reason]))).toEqual({
      expired: 'expired',
      'stale-version': 'tokenVersionStale',
      'revoked-session': 'sessionRevoked',
      'expired-session': 'sessionRevoked',
      banned: 'accountBlocked',
      'user-missing': 'userMissing',
      'disabled-key': 'apiKeyRevoked',
      'legacy-old': 'expired',
    });
  });

  it('treats a missing user tokenVersion as 0', async () => {
    await Connection.collection.insertOne({ connectionId: 'v0', userId: USER_A, tokenVersion: 0, createdAt: NOW });
    await User.collection.insertOne({ _id: new Types.ObjectId(USER_A) });

    expect(await sweep()).toEqual([]);
  });
});

describe('realtimeConnectionRepository.removeOrphanSubscribers', () => {
  it('pulls subscribers whose connection row is gone and removes emptied docs', async () => {
    await insertConnection('live');
    await insertSubscription('mixed', ['live', 'orphan-1']);
    await insertSubscription('all-orphan', ['orphan-2']);

    const removed = await realtimeConnectionRepository.removeOrphanSubscribers(1);

    expect(removed).toBe(2);
    expect(await subscriberIds('mixed')).toEqual(['live']);
    expect(await subscriberIds('all-orphan')).toBeNull();
  });
});
