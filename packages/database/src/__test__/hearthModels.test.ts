import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { Types } from 'mongoose';
import { HearthLog } from '@bike4mind/hearth';
import { connectTestDB, disconnectTestDB, cleanupTestDB } from './utils';
import { HearthChannel } from '../models/hearth/HearthChannelModel';
import { HearthActor } from '../models/hearth/HearthActorModel';
import { HearthEventDoc, PRESENCE_EVENT_RETENTION_SECONDS } from '../models/hearth/HearthEventModel';
import { HearthCursor } from '../models/hearth/HearthCursorModel';
import {
  HearthChannelCapError,
  MAX_HEARTH_CHANNELS_PER_USER,
  MongoHearthStore,
  hearthRepository,
} from '../models/hearth/MongoHearthStore';

describe('Hearth models + MongoHearthStore', () => {
  let mongoServer: MongoMemoryServer;
  const store = new MongoHearthStore();

  /** Unique constraints (channel+seq, externalId dedupe) only hold once indexes exist. */
  const ensureAllIndexes = () =>
    Promise.all([
      HearthChannel.ensureIndexes(),
      HearthActor.ensureIndexes(),
      HearthEventDoc.ensureIndexes(),
      HearthCursor.ensureIndexes(),
    ]);

  beforeAll(async () => {
    mongoServer = await connectTestDB();
    await ensureAllIndexes();
  }, 30000);

  afterAll(async () => {
    if (mongoServer) await disconnectTestDB(mongoServer);
  }, 30000);

  // Re-ensure after every cleanup: cleanupTestDB() calls dropDatabase(), which
  // drops INDEXES, and mongoose does not rebuild them. So the beforeAll setup held
  // for exactly the first test and every later one ran unindexed - which meant the
  // externalId dedupe test passed purely on the findOne fast path and never
  // reached the insert, leaving the duplicate-key recovery branch in
  // MongoHearthStore with no coverage at all. Matches
  // hearthPresenceProjection.test.ts, which had this right.
  beforeEach(async () => {
    await cleanupTestDB();
    await ensureAllIndexes();
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

  /**
   * The DUPLICATE-KEY RECOVERY branch, which the sequential dedupe test above does
   * not reach: that one returns on the findOne fast path and never inserts.
   *
   * Modelled as the exact interleaving rather than as a real race. A Promise.all
   * of two appends exercises the catch block only when the scheduler happens to
   * put both dedupe reads before either insert - so it would pass either way, and
   * a test that passes for the wrong reason is worse than no test. Here the first
   * findOne is forced to miss, which IS the losing racer's view of the world: its
   * dedupe read ran before the winner's insert committed.
   *
   * This is also what the beforeEach index fix bought - without the partial unique
   * index on (channelId, refs.externalId) the second insert simply succeeds and
   * there is no E11000 to recover from.
   */
  it('recovers the winner when a racing insert lands between the dedupe read and the insert', async () => {
    const { channelId, actorId } = await makeChannelAndActor();
    const winner = await store.appendEvent(messageInput(channelId, actorId, 'from slack', 'slack-ts-race'));

    const realFindOne = HearthEventDoc.findOne.bind(HearthEventDoc);
    let seenCalls = 0;
    const spy = vi.spyOn(HearthEventDoc, 'findOne').mockImplementation(((...args: never[]) => {
      seenCalls += 1;
      // Only the dedupe read misses; the recovery read inside the catch must be
      // real, since finding the winner is the behavior under test.
      if (seenCalls === 1) return Promise.resolve(null) as never;
      return realFindOne(...args) as never;
    }) as never);

    try {
      const loser = await store.appendEvent(messageInput(channelId, actorId, 'from slack (echo)', 'slack-ts-race'));

      // Idempotent append: the loser gets the winner back rather than an E11000.
      expect(loser.id).toBe(winner.id);
      expect(loser.seq).toBe(winner.seq);
      expect(seenCalls).toBeGreaterThanOrEqual(2);
    } finally {
      spy.mockRestore();
    }

    expect(await HearthEventDoc.countDocuments({ 'refs.externalId': 'slack-ts-race' })).toBe(1);
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
      await log.append({ ...messageInput(channelId, actorId, `msg ${i}`), origin: 'session' });
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

  it('ensureChannelByName creates once and returns the same channel thereafter', async () => {
    const first = await hearthRepository.ensureChannelByName(USER, 'agents');
    const second = await hearthRepository.ensureChannelByName(USER, 'agents');

    expect(second._id.toString()).toBe(first._id.toString());
    expect(first.nextSeq).toBe(0);
    expect(await HearthChannel.countDocuments({ name: 'agents' })).toBe(1);
  });

  it('ensureChannelByName does not duplicate under concurrent first-writes', async () => {
    // The real race: a bridge register and a hook heartbeat both arriving before
    // the channel exists. The unique (userId, name) index is what makes one win.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => hearthRepository.ensureChannelByName(USER, 'agents'))
    );

    const ids = new Set(results.map(c => c._id.toString()));
    expect(ids.size).toBe(1);
    expect(await HearthChannel.countDocuments({ userId: new Types.ObjectId(USER), name: 'agents' })).toBe(1);
  });

  it('ensureChannelByName is scoped per user', async () => {
    const OTHER = '6540b58d1f703ade3ea1e82c';
    const mine = await hearthRepository.ensureChannelByName(USER, 'agents');
    const theirs = await hearthRepository.ensureChannelByName(OTHER, 'agents');

    expect(theirs._id.toString()).not.toBe(mine._id.toString());
    expect(await hearthRepository.getOwnedChannel(USER, theirs._id.toString())).toBeNull();
  });

  describe('channel cap', () => {
    const owned = () => ({ userId: new Types.ObjectId(USER) });

    /** Seed exactly the ceiling; `agents` is one of them so the existing-name case is real. */
    async function seedChannels(userId: string, count: number) {
      const rows = await HearthChannel.insertMany(
        Array.from({ length: count }, (_, i) => ({
          userId: new Types.ObjectId(userId),
          name: i === 0 ? 'agents' : `seeded-${i}`,
        }))
      );
      return rows.map(r => r._id.toString());
    }
    const seedAtCap = () => seedChannels(USER, MAX_HEARTH_CHANNELS_PER_USER);

    /** Resolve a refusal, failing the test if the promise fulfils instead. */
    async function capRefusal(promise: Promise<unknown>): Promise<HearthChannelCapError> {
      try {
        await promise;
      } catch (err) {
        expect(err).toBeInstanceOf(HearthChannelCapError);
        return err as HearthChannelCapError;
      }
      throw new Error('expected the channel cap to refuse');
    }

    it('ensureChannelByName refuses a new channel at the cap without inserting', async () => {
      await seedAtCap();
      const create = vi.spyOn(HearthChannel, 'create');

      const err = await capRefusal(hearthRepository.ensureChannelByName(USER, 'one-too-many'));

      expect(create).not.toHaveBeenCalled();
      create.mockRestore();
      expect(err.statusCode).toBe(409);
      expect(err.additionalInfo).toEqual({ code: 'channel_limit', limit: MAX_HEARTH_CHANNELS_PER_USER });
      expect(await HearthChannel.countDocuments(owned())).toBe(MAX_HEARTH_CHANNELS_PER_USER);
    });

    it('ensureChannelByName still resolves an existing name at the cap', async () => {
      const [agentsId] = await seedAtCap();

      const channel = await hearthRepository.ensureChannelByName(USER, 'agents');

      expect(channel._id.toString()).toBe(agentsId);
      expect(await HearthChannel.countDocuments(owned())).toBe(MAX_HEARTH_CHANNELS_PER_USER);
    });

    it('createChannel enforces the same cap', async () => {
      await seedAtCap();

      const err = await capRefusal(hearthRepository.createChannel(USER, 'one-too-many'));

      expect(err.statusCode).toBe(409);
      expect(await HearthChannel.countDocuments(owned())).toBe(MAX_HEARTH_CHANNELS_PER_USER);
    });

    it('createChannel reports an owned name at the cap as a duplicate, not the cap', async () => {
      await seedAtCap();

      await expect(hearthRepository.createChannel(USER, 'agents')).rejects.toMatchObject({ code: 11000 });

      expect(await HearthChannel.countDocuments(owned())).toBe(MAX_HEARTH_CHANNELS_PER_USER);
    });

    it('ensureChannelByName returns a same-name channel created after its lookup missed', async () => {
      const [agentsId] = await seedAtCap();
      const findOne = vi.spyOn(HearthChannel, 'findOne').mockResolvedValueOnce(null as never);

      const channel = await hearthRepository.ensureChannelByName(USER, 'agents');
      findOne.mockRestore();

      expect(channel._id.toString()).toBe(agentsId);
    });

    it('allows the last channel under the cap, then refuses the next', async () => {
      await seedChannels(USER, MAX_HEARTH_CHANNELS_PER_USER - 1);

      await hearthRepository.createChannel(USER, 'the-last-one');
      expect(await HearthChannel.countDocuments(owned())).toBe(MAX_HEARTH_CHANNELS_PER_USER);

      await capRefusal(hearthRepository.createChannel(USER, 'one-too-many'));
    });

    it('counts per owner: another user at the ceiling does not refuse this one', async () => {
      const OTHER = '6540b58d1f703ade3ea1e82c';
      await seedChannels(OTHER, MAX_HEARTH_CHANNELS_PER_USER);
      await seedChannels(USER, MAX_HEARTH_CHANNELS_PER_USER - 1);

      const channel = await hearthRepository.createChannel(USER, 'mine');

      expect(channel.name).toBe('mine');
    });

    it('concurrent new names at the boundary never exceed the cap or delete existing rows', async () => {
      const seededIds = await seedChannels(USER, MAX_HEARTH_CHANNELS_PER_USER - 1);

      // Racers may all be refused; the invariant is the total, not who won.
      const results = await Promise.allSettled(
        Array.from({ length: 8 }, (_, i) => hearthRepository.ensureChannelByName(USER, `racer-${i}`))
      );
      for (const r of results) if (r.status === 'rejected') expect(r.reason).toBeInstanceOf(HearthChannelCapError);

      expect(await HearthChannel.countDocuments(owned())).toBeLessThanOrEqual(MAX_HEARTH_CHANNELS_PER_USER);
      expect(await HearthChannel.countDocuments({ _id: { $in: seededIds } })).toBe(seededIds.length);
    });

    it('keeps a row that took an event before the re-count and returns it', async () => {
      await seedChannels(USER, MAX_HEARTH_CHANNELS_PER_USER - 1);
      const realCreate = HearthChannel.create.bind(HearthChannel);
      const create = vi.spyOn(HearthChannel, 'create').mockImplementationOnce((async (doc: unknown) => {
        const row = await realCreate(doc as never);
        // A concurrent writer fills the last slot and the row takes an event.
        await HearthChannel.insertMany([{ userId: new Types.ObjectId(USER), name: 'filler' }]);
        await HearthChannel.updateOne({ _id: row._id }, { $set: { nextSeq: 1 } });
        return row;
      }) as never);

      const channel = await hearthRepository.createChannel(USER, 'in-use');
      create.mockRestore();

      expect(await HearthChannel.exists({ _id: channel._id })).not.toBeNull();
    });

    it('rolls back an unused row that lost the re-count and refuses instead of returning it', async () => {
      await seedChannels(USER, MAX_HEARTH_CHANNELS_PER_USER - 1);
      let createdId: unknown;
      const realCreate = HearthChannel.create.bind(HearthChannel);
      const create = vi.spyOn(HearthChannel, 'create').mockImplementationOnce((async (doc: unknown) => {
        const row = await realCreate(doc as never);
        createdId = row._id;
        await HearthChannel.insertMany([{ userId: new Types.ObjectId(USER), name: 'filler' }]);
        return row;
      }) as never);

      await capRefusal(hearthRepository.createChannel(USER, 'loser'));
      create.mockRestore();

      expect(await HearthChannel.exists({ _id: createdId })).toBeNull();
    });

    it('a storage failure on create propagates unchanged, not as a cap refusal', async () => {
      const boom = new Error('storage down');
      const create = vi.spyOn(HearthChannel, 'create').mockRejectedValueOnce(boom as never);

      await expect(hearthRepository.ensureChannelByName(USER, 'anything')).rejects.toBe(boom);
      create.mockRestore();
    });

    it('a same-name loser whose winner vanished retries into a live channel', async () => {
      const create = vi
        .spyOn(HearthChannel, 'create')
        .mockRejectedValueOnce(Object.assign(new Error('E11000 duplicate key'), { code: 11000 }) as never);

      const channel = await hearthRepository.ensureChannelByName(USER, 'agents');
      create.mockRestore();

      expect(await HearthChannel.exists({ _id: channel._id })).not.toBeNull();
    });

    it('a same-name loser whose winner vanished at the cap gets the 409, never the raw E11000', async () => {
      await seedChannels(USER, MAX_HEARTH_CHANNELS_PER_USER - 1);
      const create = vi.spyOn(HearthChannel, 'create').mockImplementationOnce((async () => {
        // The winner inserted, a third create filled the last slot, the winner rolled back.
        await HearthChannel.insertMany([{ userId: new Types.ObjectId(USER), name: 'filler' }]);
        throw Object.assign(new Error('E11000 duplicate key'), { code: 11000 });
      }) as never);

      const err = await capRefusal(hearthRepository.ensureChannelByName(USER, 'contested'));
      create.mockRestore();

      expect(err.statusCode).toBe(409);
    });
  });

  it('getOwnedChannel enforces ownership and tolerates malformed ids', async () => {
    const { channelId } = await makeChannelAndActor();

    expect(await hearthRepository.getOwnedChannel(USER, channelId)).not.toBeNull();
    expect(await hearthRepository.getOwnedChannel('6540b58d1f703ade3ea1e82c', channelId)).toBeNull();
    expect(await hearthRepository.getOwnedChannel(USER, 'not-an-object-id')).toBeNull();
  });

  it('getOwnedActor enforces ownership and tolerates malformed ids', async () => {
    const { actorId } = await makeChannelAndActor();

    expect(await hearthRepository.getOwnedActor(USER, actorId)).not.toBeNull();
    expect(await hearthRepository.getOwnedActor('6540b58d1f703ade3ea1e82c', actorId)).toBeNull();
    expect(await hearthRepository.getOwnedActor(USER, 'not-an-object-id')).toBeNull();
  });

  it('round-trips origin, and leaves it unset when absent', async () => {
    const { channelId, actorId } = await makeChannelAndActor();

    await store.appendEvent({ ...messageInput(channelId, actorId, 'keyed'), origin: 'api-key' });
    await store.appendEvent(messageInput(channelId, actorId, 'legacy'));

    const [keyed, legacy] = await store.eventsSince(channelId, 0);
    expect(keyed.origin).toBe('api-key');
    expect(legacy.origin).toBeUndefined();
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

      // Run the declared filter as a query - but the filter alone is NOT what the
      // reaper deletes. It also requires createdAt to be a BSON Date, so if a later
      // change dropped `timestamps` or stored createdAt as a string, retention
      // would stop silently and a filter-only assertion would still pass. Both
      // halves are asserted here.
      const [, options] = presenceTtlIndex();
      const doomed = await HearthEventDoc.find({
        ...(options?.partialFilterExpression ?? {}),
        createdAt: { $type: 'date' },
      });
      expect(doomed.map(d => d._id.toString())).toEqual([presence.id]);
      expect(doomed[0].createdAt).toBeInstanceOf(Date);
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

  describe('per-session actor identity', () => {
    /**
     * The defect this guards: actor identity is (userId, kind, displayName), so
     * before sessions were discriminated every CLI session of one user resolved
     * to ONE actor and therefore ONE cursor per channel. Two agents running
     * catchup on the same channel consumed each other's events and each saw a
     * partial, non-overlapping slice while believing it was current.
     */
    it('gives concurrent sessions independent cursors over the same channel', async () => {
      const channel = await hearthRepository.createChannel(USER, 'agents');
      const channelId = channel._id.toString();
      const log = new HearthLog(store);

      const sessionA = await hearthRepository.ensureActor(USER, 'human', 'erik (amber-otter)');
      const sessionB = await hearthRepository.ensureActor(USER, 'human', 'erik (teal-lynx)');
      expect(sessionA._id.toString()).not.toBe(sessionB._id.toString());

      const writer = await hearthRepository.ensureActor(USER, 'agent', 'writer');
      for (const text of ['one', 'two', 'three']) {
        await store.appendEvent(messageInput(channelId, writer._id.toString(), text));
      }

      // Each session must see ALL three, not a slice the other left behind.
      const seenByA = await log.catchup(sessionA._id.toString(), channelId, { advance: true });
      const seenByB = await log.catchup(sessionB._id.toString(), channelId, { advance: true });
      expect(seenByA.map(e => e.human.text)).toEqual(['one', 'two', 'three']);
      expect(seenByB.map(e => e.human.text)).toEqual(['one', 'two', 'three']);

      // And advancing one cursor must not move the other's.
      expect(await store.getCursor(sessionA._id.toString(), channelId)).toBe(3);
      expect(await store.getCursor(sessionB._id.toString(), channelId)).toBe(3);
      await store.appendEvent(messageInput(channelId, writer._id.toString(), 'four'));
      expect((await log.catchup(sessionA._id.toString(), channelId, { advance: true })).map(e => e.human.text)).toEqual(
        ['four']
      );
      expect((await log.catchup(sessionB._id.toString(), channelId, { advance: true })).map(e => e.human.text)).toEqual(
        ['four']
      );
    });

    it('keeps one actor per session identity across repeat calls', async () => {
      const first = await hearthRepository.ensureActor(USER, 'human', 'erik (amber-otter)');
      const again = await hearthRepository.ensureActor(USER, 'human', 'erik (amber-otter)');
      expect(again._id.toString()).toBe(first._id.toString());
    });
  });

  describe('actor display label', () => {
    /**
     * displayLabel exists so a RENAMEABLE name (a notebook's, which B4M also
     * auto-titles) can be shown without entering the identity key. If it ever
     * reached the key, a rename would mint a new actor - and a new cursor -
     * mid-session, which is the exact defect the per-session work fixed.
     */
    it('refreshes on later calls without changing actor identity', async () => {
      const first = await hearthRepository.ensureActor(USER, 'human', 'erik (amber-otter)', {
        displayLabel: 'erik (planning notebook)',
      });
      const renamed = await hearthRepository.ensureActor(USER, 'human', 'erik (amber-otter)', {
        displayLabel: 'erik (shipping notebook)',
      });

      expect(renamed._id.toString()).toBe(first._id.toString());
      expect(renamed.displayLabel).toBe('erik (shipping notebook)');
    });

    it('leaves a stored label alone when a caller supplies none', async () => {
      const actor = await hearthRepository.ensureActor(USER, 'human', 'erik (amber-otter)', {
        displayLabel: 'erik (planning notebook)',
      });
      const withoutLabel = await hearthRepository.ensureActor(USER, 'human', 'erik (amber-otter)');

      expect(withoutLabel._id.toString()).toBe(actor._id.toString());
      expect(withoutLabel.displayLabel).toBe('erik (planning notebook)');
    });

    it('renders the label in preference to the identity name, falling back when absent', async () => {
      const labelled = await hearthRepository.ensureActor(USER, 'human', 'erik (amber-otter)', {
        displayLabel: 'erik (planning notebook)',
      });
      const bare = await hearthRepository.ensureActor(USER, 'agent', 'Claude Code (teal-lynx)');

      const identities = await hearthRepository.actorIdentitiesById([labelled._id.toString(), bare._id.toString()]);
      expect(identities.get(labelled._id.toString())).toEqual({
        displayName: 'erik (planning notebook)',
        kind: 'human',
      });
      expect(identities.get(bare._id.toString())).toEqual({ displayName: 'Claude Code (teal-lynx)', kind: 'agent' });
    });
  });
});
