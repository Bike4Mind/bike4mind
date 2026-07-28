import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Types } from 'mongoose';
import { HearthLog } from '@bike4mind/hearth';
import { connectTestDB, disconnectTestDB, cleanupTestDB } from './utils';
import { HearthChannel } from '../models/hearth/HearthChannelModel';
import { HearthActor } from '../models/hearth/HearthActorModel';
import { HearthEventDoc, PRESENCE_EVENT_RETENTION_SECONDS } from '../models/hearth/HearthEventModel';
import { HearthCursor } from '../models/hearth/HearthCursorModel';
import { MongoHearthStore, hearthRepository } from '../models/hearth/MongoHearthStore';

describe('Hearth models + MongoHearthStore', () => {
  let mongoServer: MongoMemoryServer;
  const store = new MongoHearthStore();

  beforeAll(async () => {
    mongoServer = await connectTestDB();
    // Unique constraints (channel+seq, externalId dedupe) only hold once indexes exist.
    await Promise.all([
      HearthChannel.ensureIndexes(),
      HearthActor.ensureIndexes(),
      HearthEventDoc.ensureIndexes(),
      HearthCursor.ensureIndexes(),
    ]);
  }, 30000);

  afterAll(async () => {
    if (mongoServer) await disconnectTestDB(mongoServer);
  }, 30000);

  beforeEach(async () => {
    await cleanupTestDB();
  });

  const USER = '6540b58d1f703ade3ea1e82b';

  async function makeChannelAndActor() {
    const channel = await hearthRepository.createChannel(USER, 'general');
    const actor = await hearthRepository.ensureActor(USER, 'human', 'Erik');
    return { channelId: channel._id.toString(), actorId: actor._id.toString() };
  }

  function messageInput(channelId: string, actorId: string, text: string, externalId?: string) {
    return {
      channelId,
      actorId,
      kind: 'message' as const,
      human: { text, format: 'text' as const },
      refs: externalId ? { externalId } : {},
    };
  }

  it('allocates strictly increasing, collision-free seqs under concurrent appends', async () => {
    const { channelId, actorId } = await makeChannelAndActor();

    const events = await Promise.all(
      Array.from({ length: 25 }, (_, i) => store.appendEvent(messageInput(channelId, actorId, `msg ${i}`)))
    );

    const seqs = events.map(e => e.seq).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
  });

  it('round-trips a machine body (schema + payload) and thread refs', async () => {
    const { channelId, actorId } = await makeChannelAndActor();

    const event = await store.appendEvent({
      channelId,
      actorId,
      kind: 'delegation',
      human: { text: 'Delegation to dev-1: run tests', format: 'text' },
      machine: { schema: 'hearth.delegation@1', payload: { targetActorId: 'dev-1', task: 'run tests' } },
      refs: { threadRootId: 'ev-root', questId: 'q-1' },
    });

    const [read] = await store.eventsSince(channelId, 0);
    expect(read.machine).toEqual({
      schema: 'hearth.delegation@1',
      payload: { targetActorId: 'dev-1', task: 'run tests' },
    });
    expect(read.refs.threadRootId).toBe('ev-root');
    expect(read.refs.questId).toBe('q-1');
    expect(read.id).toBe(event.id);
  });

  it('appendEvent rejects unknown channels', async () => {
    const { actorId } = await makeChannelAndActor();
    await expect(store.appendEvent(messageInput('6540b58d1f703ade3ea1e82c', actorId, 'orphan'))).rejects.toThrow(
      /channel not found/i
    );
  });

  it('dedupes appends by refs.externalId (gateway echo)', async () => {
    const { channelId, actorId } = await makeChannelAndActor();

    const first = await store.appendEvent(messageInput(channelId, actorId, 'from slack', 'slack-ts-1'));
    const echo = await store.appendEvent(messageInput(channelId, actorId, 'from slack (echo)', 'slack-ts-1'));

    expect(echo.id).toBe(first.id);
    expect(echo.seq).toBe(first.seq);
    expect(await HearthEventDoc.countDocuments({})).toBe(1);
  });

  it('eventsSince returns ordered events after a seq, honoring limit', async () => {
    const { channelId, actorId } = await makeChannelAndActor();
    for (let i = 0; i < 5; i++) {
      await store.appendEvent(messageInput(channelId, actorId, `msg ${i}`));
    }

    const after2 = await store.eventsSince(channelId, 2);
    expect(after2.map(e => e.seq)).toEqual([3, 4, 5]);

    const limited = await store.eventsSince(channelId, 0, { limit: 2 });
    expect(limited.map(e => e.seq)).toEqual([1, 2]);
  });

  it('cursors default to 0, advance, and never rewind', async () => {
    const { channelId, actorId } = await makeChannelAndActor();

    expect(await store.getCursor(actorId, channelId)).toBe(0);

    await store.setCursor(actorId, channelId, 7);
    expect(await store.getCursor(actorId, channelId)).toBe(7);

    await store.setCursor(actorId, channelId, 3);
    expect(await store.getCursor(actorId, channelId)).toBe(7);
  });

  it('HearthLog catchup over the Mongo store advances the cursor', async () => {
    const { channelId, actorId } = await makeChannelAndActor();
    const log = new HearthLog(store);

    for (let i = 0; i < 3; i++) {
      await log.append(messageInput(channelId, actorId, `msg ${i}`));
    }

    const events = await log.catchup(actorId, channelId);
    expect(events.map(e => e.seq)).toEqual([1, 2, 3]);
    expect(await store.getCursor(actorId, channelId)).toBe(3);

    expect(await log.catchup(actorId, channelId)).toEqual([]);
  });

  it('ensureActor is idempotent per (user, kind, displayName)', async () => {
    const [a, b] = await Promise.all([
      hearthRepository.ensureActor(USER, 'agent', 'Spock'),
      hearthRepository.ensureActor(USER, 'agent', 'Spock'),
    ]);
    expect(a._id.toString()).toBe(b._id.toString());
  });

  it('getOwnedChannel enforces ownership and tolerates malformed ids', async () => {
    const { channelId } = await makeChannelAndActor();

    expect(await hearthRepository.getOwnedChannel(USER, channelId)).not.toBeNull();
    expect(await hearthRepository.getOwnedChannel('6540b58d1f703ade3ea1e82c', channelId)).toBeNull();
    expect(await hearthRepository.getOwnedChannel(USER, 'not-an-object-id')).toBeNull();
  });

  /**
   * The TTL contract, not the reaper: Mongo's TTL monitor runs on a ~60s
   * background interval, so waiting for real expiry would be slow and flaky.
   * These assert what we control - which documents the index selects.
   */
  describe('presence event retention', () => {
    // schema.indexes() returns [keys, options] pairs; narrowed locally because
    // the mongoose type is a broad union that hides expireAfterSeconds.
    type DeclaredIndex = [
      Record<string, number>,
      { name?: string; expireAfterSeconds?: number; partialFilterExpression?: Record<string, unknown> } | undefined,
    ];

    function presenceTtlIndex(): DeclaredIndex {
      const declared = HearthEventDoc.schema.indexes() as unknown as DeclaredIndex[];
      const match = declared.find(([, options]) => options?.expireAfterSeconds !== undefined);
      expect(match, 'no TTL index declared on HearthEvent').toBeDefined();
      return match as DeclaredIndex;
    }

    it('declares exactly one TTL index, on createdAt, filtered to presence only', () => {
      const declared = HearthEventDoc.schema.indexes() as unknown as DeclaredIndex[];
      const ttls = declared.filter(([, options]) => options?.expireAfterSeconds !== undefined);
      expect(ttls).toHaveLength(1);

      const [keys, options] = presenceTtlIndex();
      expect(keys).toEqual({ createdAt: 1 });
      expect(options?.expireAfterSeconds).toBe(PRESENCE_EVENT_RETENTION_SECONDS);
      expect(options?.expireAfterSeconds).toBeGreaterThan(0);
      // Exact shape, not a superset: a broader filter (an $in, an $exists) would
      // silently start expiring facts.
      expect(options?.partialFilterExpression).toEqual({ kind: 'presence' });
    });

    it('builds the TTL index in Mongo with its filter intact', async () => {
      // beforeEach drops the database, so re-create indexes inside the test.
      await HearthEventDoc.ensureIndexes();
      const live = await HearthEventDoc.collection.indexes();

      const ttl = live.find(idx => idx.name === 'hearth_event_presence_ttl');
      expect(ttl, 'presence TTL index missing from the collection').toBeDefined();
      expect(ttl?.expireAfterSeconds).toBe(PRESENCE_EVENT_RETENTION_SECONDS);
      expect(ttl?.partialFilterExpression).toEqual({ kind: 'presence' });
    });

    it('selects presence events and no other kind', async () => {
      const { channelId, actorId } = await makeChannelAndActor();
      await store.appendEvent(messageInput(channelId, actorId, 'a fact, kept forever'));
      const presence = await store.appendEvent({
        channelId,
        actorId,
        kind: 'presence',
        human: { text: 'running', format: 'text' },
        refs: {},
      });

      // Run the declared filter as a query: what it matches is exactly what the
      // reaper would delete.
      const [, options] = presenceTtlIndex();
      const doomed = await HearthEventDoc.find(options?.partialFilterExpression ?? {});
      expect(doomed.map(d => d._id.toString())).toEqual([presence.id]);
    });

    it('eventsSince stays correctly ordered when seq has gaps', async () => {
      const { channelId, actorId } = await makeChannelAndActor();

      // Insert non-contiguous seqs directly: this is the post-reaper shape of a
      // channel whose presence events have expired. Written out of order too,
      // so the assertion cannot pass on insertion order alone.
      for (const seq of [7, 2, 11, 4]) {
        await HearthEventDoc.create({
          channelId: new Types.ObjectId(channelId),
          seq,
          actorId: new Types.ObjectId(actorId),
          kind: 'message',
          human: { text: `msg ${seq}`, format: 'text' },
          refs: {},
        });
      }

      expect((await store.eventsSince(channelId, 0)).map(e => e.seq)).toEqual([2, 4, 7, 11]);
      expect((await store.eventsSince(channelId, 4)).map(e => e.seq)).toEqual([7, 11]);
      // A cursor sitting in a gap must resume at the next surviving event, not stall.
      expect((await store.eventsSince(channelId, 5)).map(e => e.seq)).toEqual([7, 11]);
      expect((await store.eventsSince(channelId, 0, { limit: 2 })).map(e => e.seq)).toEqual([2, 4]);
    });
  });
});
