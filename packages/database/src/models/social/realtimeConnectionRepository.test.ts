import { ApiKeyStatus } from '@bike4mind/common';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { setupMongoTest } from '../../__test__/utils';
import { AuthSessionModel } from '../auth/AuthSessionModel';
import { UserApiKey } from '../auth/UserApiKeyModel';
import User from '../auth/UserModel';
import { Connection } from './ConnectionModel';
import { QuerySubscription } from './QuerySubscriptionModel';
import {
  REALTIME_CONNECTION_MAX_LIFETIME_MS,
  REALTIME_REAUTH_SKEW_MS,
  realtimeConnectionRepository,
} from './realtimeConnectionRepository';

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

// Live connections: Connection reads skip ended rows.
const connectionIds = async () => (await Connection.find({}).distinct('connectionId')).sort();
// Every row, ended or not, bypassing the model's read filter.
const rawRows = async () =>
  (await Connection.collection.find({}).toArray()).sort((a, b) => a.connectionId.localeCompare(b.connectionId));
const endedIds = async () => (await rawRows()).filter(row => row.endedAt).map(row => row.connectionId as string);
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

  it('keeps the excepted session, sid-less rows and API-key connections with exceptSid + sessionsOnly', async () => {
    await insertConnection('keep', { sid: 's-current' });
    await insertConnection('other', { sid: 's-other' });
    await insertConnection('legacy');
    await insertConnection('key', { apiKeyId: 'k1' });

    await realtimeConnectionRepository.endConnections({
      userId: USER_A,
      exceptSid: 's-current',
      sessionsOnly: true,
    });

    expect(await connectionIds()).toEqual(['keep', 'key', 'legacy']);
    expect(await endedIds()).toEqual(['other']);
  });

  it('ends an API key connections by apiKeyId', async () => {
    await insertConnection('key-1', { apiKeyId: 'k1' });
    await insertConnection('key-2', { apiKeyId: 'k2' });

    await realtimeConnectionRepository.endConnections({ apiKeyId: 'k1' });

    expect(await connectionIds()).toEqual(['key-2']);
  });

  it('marks the rows ended instead of deleting them, and live reads ignore them', async () => {
    await insertConnection('a1', { sid: 's1' });
    await insertConnection('a2', { sid: 's2' });

    await realtimeConnectionRepository.endConnections({ sid: 's1' });

    expect((await rawRows()).map(row => row.connectionId)).toEqual(['a1', 'a2']);
    expect(await endedIds()).toEqual(['a1']);
    expect(await Connection.findOne({ connectionId: 'a1' }).lean()).toBeNull();
    expect(await Connection.find({ userId: USER_A })).toHaveLength(1);
    expect(await Connection.findByUserId(USER_A)).toHaveLength(1);
    expect(await Connection.countDocuments({ userId: USER_A })).toBe(1);
    expect(await Connection.find({ userId: USER_A }).distinct('connectionId')).toEqual(['a2']);
  });

  it('keeps the first endedAt when a row is ended again', async () => {
    await insertConnection('a1');
    await realtimeConnectionRepository.endConnections({ connectionIds: ['a1'] });
    const first = (await rawRows())[0].endedAt;

    await realtimeConnectionRepository.endConnections({ connectionIds: ['a1'] });

    expect((await rawRows())[0].endedAt).toEqual(first);
  });

  it('does not look up already-ended rows by user, so a repeat revoke reports nothing new', async () => {
    await insertConnection('a1');
    await realtimeConnectionRepository.endConnections({ userId: USER_A });

    const result = await realtimeConnectionRepository.endConnections({ userId: USER_A });

    expect(result.connectionIds).toEqual([]);
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
    expect(await endedIds()).toEqual(['a1']);
  });

  it('is a no-op when nothing matches', async () => {
    await insertConnection('a1');
    await insertSubscription('q', ['a1']);

    expect(await realtimeConnectionRepository.endConnections({ sid: 'missing' })).toEqual({ connectionIds: [] });
    expect(await subscriberIds('q')).toEqual(['a1']);
  });
});

describe('realtimeConnectionRepository filter guards', () => {
  it.each([
    ['an undefined sid', { sid: undefined as never }],
    ['an empty sid', { sid: '' }],
    ['an undefined apiKeyId', { apiKeyId: undefined as never }],
    ['an undefined userId', { userId: undefined as never }],
    ['an undefined exceptSid', { userId: USER_A, exceptSid: undefined }],
    ['an empty connectionIds list', { connectionIds: [] }],
    ['a non-string connection id', { connectionIds: [undefined as never] }],
  ])('refuses %s and leaves every row untouched', async (_name, filter) => {
    await insertConnection('a1', { sid: 's1' });
    await insertConnection('b1', { userId: USER_B });

    await expect(realtimeConnectionRepository.endConnections(filter)).rejects.toThrow(TypeError);

    expect(await connectionIds()).toEqual(['a1', 'b1']);
    expect(await endedIds()).toEqual([]);
  });

  it('does not end a legacy sid-less connection when excepting a session', async () => {
    await insertConnection('current', { sid: 's-current' });
    await insertConnection('other', { sid: 's-other' });
    await insertConnection('legacy');

    await realtimeConnectionRepository.endConnections({ userId: USER_A, exceptSid: 's-current' });

    expect(await endedIds()).toEqual(['other']);
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

  it('stamps reauthAt', async () => {
    await insertConnection('a1');

    await realtimeConnectionRepository.reauthenticate('a1', { tokenVersion: 0, authExpiresAt: at(minutes(60)) });

    expect((await rawRows())[0].reauthAt).toBeInstanceOf(Date);
  });

  it('refuses to revive an ended connection', async () => {
    await insertConnection('a1');
    await realtimeConnectionRepository.endConnections({ connectionIds: ['a1'] });

    const updated = await realtimeConnectionRepository.reauthenticate('a1', {
      tokenVersion: 1,
      authExpiresAt: at(minutes(60)),
    });

    expect(updated).toBe(false);
    expect((await rawRows())[0]).toMatchObject({ tokenVersion: 0 });
  });

  it('returns false when the connection row is gone', async () => {
    expect(await realtimeConnectionRepository.reauthenticate('missing', { tokenVersion: 0, authExpiresAt: NOW })).toBe(
      false
    );
  });
});

describe('realtimeConnectionRepository sweep reads', () => {
  const params = {
    now: NOW,
    graceMs: GRACE_MS,
    isAccountBlocked: (user: { isBanned?: boolean | null }) => !!user.isBanned,
  };

  // Walks both phases the way the cron does.
  const sweep = async (batchSize?: number) => {
    const targets = [];
    for (const phase of ['live', 'ended'] as const) {
      let cursor: Awaited<ReturnType<typeof realtimeConnectionRepository.readSweepPage>>['next'] = {
        phase,
        afterId: null,
      };
      while (cursor) {
        const page = await realtimeConnectionRepository.readSweepPage(cursor, batchSize);
        cursor = page.next;
        targets.push(...(await realtimeConnectionRepository.classifySweepRows(page.rows, params)));
      }
    }
    return targets;
  };

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

  it('targets ended rows for a socket close, and lapsed ended rows for deletion', async () => {
    await insertUser(USER_A);
    await insertConnection('just-ended', { endedAt: at(-minutes(1)) });
    await insertConnection('long-ended', { endedAt: at(-REALTIME_CONNECTION_MAX_LIFETIME_MS - minutes(3)) });
    await insertConnection('live');

    const targets = await sweep(2);

    expect(Object.fromEntries(targets.map(target => [target.connectionId, target.reason]))).toEqual({
      'just-ended': 'ended',
      'long-ended': 'endedLapsed',
    });
  });

  it('pages the live phase without returning ended rows', async () => {
    await insertConnection('live');
    await insertConnection('ended', { endedAt: at(-minutes(1)) });

    const page = await realtimeConnectionRepository.readSweepPage({ phase: 'live', afterId: null });

    expect(page.rows.map(row => row.connectionId)).toEqual(['live']);
    expect(page.next).toBeNull();
  });
});

describe('realtimeConnectionRepository.deleteEndedConnections', () => {
  it('deletes ended rows only, never a live one', async () => {
    await insertConnection('ended', { endedAt: at(-minutes(1)) });
    await insertConnection('live');

    const deleted = await realtimeConnectionRepository.deleteEndedConnections(['ended', 'live']);

    expect(deleted).toBe(1);
    expect((await rawRows()).map(row => row.connectionId)).toEqual(['live']);
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

  it('pulls subscribers whose connection row is ended', async () => {
    await insertConnection('live');
    await insertConnection('ended', { endedAt: at(-minutes(1)) });
    await insertSubscription('mixed', ['live', 'ended']);

    const removed = await realtimeConnectionRepository.removeOrphanSubscribers();

    expect(removed).toBe(1);
    expect(await subscriberIds('mixed')).toEqual(['live']);
  });
});

describe('realtimeConnectionRepository.removeStaleSubscribers', () => {
  const entry = (clientId: string, createdAt?: Date) => ({
    endpoint: 'e',
    connectionId: 'a1',
    clientId,
    attempts: 0,
    ...(createdAt && { createdAt }),
  });
  const insertEntries = (subscribers: ReturnType<typeof entry>[]) =>
    QuerySubscription.collection.insertOne({
      collectionName: 'quests',
      queryId: 'q',
      query: {},
      fields: {},
      subscribers,
    });
  const remainingClients = async () =>
    ((await QuerySubscription.findOne({ queryId: 'q' }).lean())?.subscribers ?? []).map(sub => sub.clientId).sort();

  it('pulls entries made before the connection last reauthenticated, and keeps newer ones', async () => {
    await insertConnection('a1', { reauthAt: at(-minutes(5)) });
    await insertConnection('a2');
    await QuerySubscription.collection.insertOne({
      collectionName: 'quests',
      queryId: 'q',
      query: {},
      fields: {},
      subscribers: [
        { endpoint: 'e', connectionId: 'a1', clientId: 'old', attempts: 0, createdAt: at(-minutes(10)) },
        { endpoint: 'e', connectionId: 'a1', clientId: 'new', attempts: 0, createdAt: at(-minutes(1)) },
        { endpoint: 'e', connectionId: 'a2', clientId: 'other', attempts: 0, createdAt: at(-minutes(10)) },
      ],
    });

    const removed = await realtimeConnectionRepository.removeStaleSubscribers({ now: NOW });

    expect(removed).toBe(1);
    expect(await remainingClients()).toEqual(['new', 'other']);
  });

  it('pulls an entry older than reauthAt minus the skew and keeps one 10s newer than that boundary', async () => {
    const reauthAt = at(-minutes(5));
    const boundary = reauthAt.getTime() - REALTIME_REAUTH_SKEW_MS;
    await insertConnection('a1', { reauthAt });
    await insertEntries([
      entry('older', new Date(boundary - 10_000)),
      entry('within-skew', new Date(boundary + 10_000)),
    ]);

    await realtimeConnectionRepository.removeStaleSubscribers({ now: NOW });

    expect(await remainingClients()).toEqual(['within-skew']);
  });

  it('does not scan a row reauthed more than 15 minutes ago', async () => {
    await insertConnection('a1', { reauthAt: at(-minutes(20)) });
    await insertEntries([entry('old', at(-minutes(30)))]);

    const removed = await realtimeConnectionRepository.removeStaleSubscribers({ now: NOW });

    expect(removed).toBe(0);
    expect(await remainingClients()).toEqual(['old']);
  });

  it('never pulls a subscriber entry that has no createdAt', async () => {
    await insertConnection('a1', { reauthAt: at(-minutes(5)) });
    await insertEntries([entry('undated')]);

    const removed = await realtimeConnectionRepository.removeStaleSubscribers({ now: NOW });

    expect(removed).toBe(0);
    expect(await remainingClients()).toEqual(['undated']);
  });
});

describe('realtimeConnectionRepository.endExpiredConnections', () => {
  const expiredBefore = at(-GRACE_MS);

  it('ends a lapsed row, pulls its subscribers and reports it as ended', async () => {
    await insertConnection('lapsed', { authExpiresAt: at(-minutes(3)) });
    await insertSubscription('q', ['lapsed']);

    const ended = await realtimeConnectionRepository.endExpiredConnections(['lapsed'], expiredBefore);

    expect(ended).toEqual(['lapsed']);
    expect(await endedIds()).toEqual(['lapsed']);
    expect(await subscriberIds('q')).toBeNull();
  });

  it('leaves a row reauthed after classification live and unreported', async () => {
    await insertConnection('reauthed', { authExpiresAt: at(minutes(30)), reauthAt: NOW });
    await insertSubscription('q', ['reauthed']);

    const ended = await realtimeConnectionRepository.endExpiredConnections(['reauthed'], expiredBefore);

    expect(ended).toEqual([]);
    expect(await endedIds()).toEqual([]);
    expect(await connectionIds()).toEqual(['reauthed']);
    expect(await subscriberIds('q')).toEqual(['reauthed']);
  });
});

describe('Connection ended-row filtering', () => {
  it('still hides ended rows when a filter names endedAt as undefined', async () => {
    await insertConnection('live');
    await insertConnection('ended', { endedAt: at(-minutes(1)) });

    const rows = await Connection.find({ endedAt: undefined }).lean();

    expect(rows.map(row => row.connectionId)).toEqual(['live']);
  });

  it('returns ended rows only with the includeEnded option', async () => {
    await insertConnection('ended', { endedAt: at(-minutes(1)) });

    expect(await Connection.find({ endedAt: { $exists: true } }).lean()).toEqual([]);
    expect(await Connection.find({}).setOptions({ includeEnded: true }).lean()).toHaveLength(1);
  });
});
