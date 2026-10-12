import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../__test__/createMongoServer';
import { Session, sessionRepository } from './SessionModel';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: Awaited<ReturnType<typeof createMongoServer>>;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

beforeEach(async () => {
  // Raw collection: Session.deleteMany is a soft delete, which would leak rows between tests.
  await Session.collection.deleteMany({});
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

async function seed(
  name: string,
  voiceReservedCredits: number | null,
  voiceSessionStartedAt: Date | null,
  extra: { voiceProviderConversationIds?: string[]; deletedAt?: Date } = {}
) {
  const now = new Date();
  const doc = await Session.create({
    name,
    userId: 'user-1',
    firstCreated: now,
    lastUpdated: now,
    voiceReservedCredits,
    voiceSessionStartedAt,
    ...extra,
  });
  return doc.id as string;
}

describe('sessionRepository voice holds', () => {
  it('finds only live holds started before the cutoff, oldest first and bounded', async () => {
    const oldest = await seed('oldest', 100, minutesAgo(90));
    const older = await seed('older', 100, minutesAgo(60));
    await seed('third', 100, minutesAgo(45));
    await seed('recent', 100, minutesAgo(1));
    await seed('no-reservation', null, minutesAgo(60));
    await seed('settled', null, null);

    const holds = await sessionRepository.findStaleVoiceHolds(minutesAgo(30), 2);

    expect(holds.map(h => h.id)).toEqual([oldest, older]);
    expect(holds[0]).toMatchObject({ userId: 'user-1', voiceReservedCredits: 100 });
    expect(holds[0].voiceSessionStartedAt).toBeInstanceOf(Date);
  });

  it('lets exactly one concurrent claim win and clears the hold', async () => {
    const startedAt = minutesAgo(60);
    const id = await seed('call', 100, startedAt);

    const results = await Promise.all([
      sessionRepository.claimVoiceHold(id, startedAt),
      sessionRepository.claimVoiceHold(id, startedAt),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await Session.findById(id).lean();
    expect(after).toMatchObject({ voiceReservedCredits: null, voiceSessionStartedAt: null });
  });

  it("never claims a newer call's hold with a stale start time", async () => {
    const id = await seed('call', 100, minutesAgo(1));

    expect(await sessionRepository.claimVoiceHold(id, minutesAgo(60))).toBe(false);
    expect(await Session.findById(id).lean()).toMatchObject({ voiceReservedCredits: 100 });
  });

  it('restores a claimed hold, but never over a newer call', async () => {
    const startedAt = minutesAgo(60);
    const id = await seed('call', 100, startedAt);
    await sessionRepository.claimVoiceHold(id, startedAt);

    expect(await sessionRepository.restoreVoiceHold(id, 100, startedAt)).toBe(true);
    expect(await Session.findById(id).lean()).toMatchObject({
      voiceReservedCredits: 100,
      voiceSessionStartedAt: startedAt,
    });

    // The hold is live again, so a second restore (standing in for a newer call's hold) must not overwrite it.
    expect(await sessionRepository.restoreVoiceHold(id, 999, minutesAgo(1))).toBe(false);
    expect(await Session.findById(id).lean()).toMatchObject({ voiceReservedCredits: 100 });
  });

  describe('a notebook deleted mid-call', () => {
    const IDS = ['conv_a', 'conv_b'];

    it('still surfaces its stale hold, with the provider conversation ids', async () => {
      const id = await seed('deleted', 100, minutesAgo(60), {
        voiceProviderConversationIds: IDS,
        deletedAt: new Date(),
      });

      const holds = await sessionRepository.findStaleVoiceHolds(minutesAgo(30), 10);

      expect(holds).toHaveLength(1);
      expect(holds[0]).toMatchObject({ id, voiceReservedCredits: 100, voiceProviderConversationIds: IDS });
    });

    it('can be claimed, which clears the provider ids, and restored with them', async () => {
      const startedAt = minutesAgo(60);
      const id = await seed('deleted', 100, startedAt, { voiceProviderConversationIds: IDS, deletedAt: new Date() });

      expect(await sessionRepository.claimVoiceHold(id, startedAt)).toBe(true);
      expect(await Session.findById(id).setOptions({ includeDeleted: true }).lean()).toMatchObject({
        voiceReservedCredits: null,
        voiceSessionStartedAt: null,
        voiceProviderConversationIds: [],
      });

      expect(await sessionRepository.restoreVoiceHold(id, 100, startedAt, IDS)).toBe(true);
      expect(await Session.findById(id).setOptions({ includeDeleted: true }).lean()).toMatchObject({
        voiceReservedCredits: 100,
        voiceSessionStartedAt: startedAt,
        voiceProviderConversationIds: IDS,
      });
    });
  });

  it('clears the provider ids when a live session hold is claimed', async () => {
    const startedAt = minutesAgo(60);
    const id = await seed('call', 100, startedAt, { voiceProviderConversationIds: ['conv_a'] });

    await sessionRepository.claimVoiceHold(id, startedAt);

    expect(await Session.findById(id).lean()).toMatchObject({ voiceProviderConversationIds: [] });
  });

  describe('claiming against the measured provider conversations', () => {
    it('claims while the ids match what was measured', async () => {
      const startedAt = minutesAgo(5);
      const id = await seed('call', 100, startedAt, { voiceProviderConversationIds: ['conv_a', 'conv_b'] });

      expect(await sessionRepository.claimVoiceHold(id, startedAt, ['conv_a', 'conv_b'])).toBe(true);
    });

    it('leaves the hold live when a reconnect appended an id after the measurement', async () => {
      const startedAt = minutesAgo(5);
      const id = await seed('call', 100, startedAt, { voiceProviderConversationIds: ['conv_a'] });
      await sessionRepository.appendVoiceProviderConversationId(id, startedAt, 'conv_b');

      expect(await sessionRepository.claimVoiceHold(id, startedAt, ['conv_a'])).toBe(false);
      expect(await Session.findById(id).lean()).toMatchObject({
        voiceReservedCredits: 100,
        voiceProviderConversationIds: ['conv_a', 'conv_b'],
      });
    });

    it('treats a hold with no recorded ids as matching an empty measurement', async () => {
      const startedAt = minutesAgo(5);
      const id = await seed('call', 100, startedAt);
      await Session.collection.updateOne(
        { _id: new mongoose.Types.ObjectId(id) },
        { $unset: { voiceProviderConversationIds: '' } }
      );

      expect(await sessionRepository.claimVoiceHold(id, startedAt, [])).toBe(true);
    });

    it('does not claim an empty measurement once a reconnect recorded an id', async () => {
      const startedAt = minutesAgo(5);
      const id = await seed('call', 100, startedAt);
      await sessionRepository.appendVoiceProviderConversationId(id, startedAt, 'conv_a');

      expect(await sessionRepository.claimVoiceHold(id, startedAt, [])).toBe(false);
    });
  });

  describe('appendVoiceProviderConversationId', () => {
    it('keeps every id when reconnects append concurrently', async () => {
      const startedAt = minutesAgo(5);
      const id = await seed('call', 100, startedAt, { voiceProviderConversationIds: ['conv_a'] });

      const results = await Promise.all(
        ['conv_b', 'conv_c', 'conv_d'].map(conv =>
          sessionRepository.appendVoiceProviderConversationId(id, startedAt, conv)
        )
      );

      expect(results).toEqual([true, true, true]);
      const after = await Session.findById(id).lean();
      expect([...(after?.voiceProviderConversationIds ?? [])].sort()).toEqual(['conv_a', 'conv_b', 'conv_c', 'conv_d']);
    });

    it('records a repeated id once', async () => {
      const startedAt = minutesAgo(5);
      const id = await seed('call', 100, startedAt, { voiceProviderConversationIds: ['conv_a'] });

      expect(await sessionRepository.appendVoiceProviderConversationId(id, startedAt, 'conv_a')).toBe(true);
      expect(await Session.findById(id).lean()).toMatchObject({ voiceProviderConversationIds: ['conv_a'] });
    });

    it('attaches nothing once the hold has been claimed', async () => {
      const startedAt = minutesAgo(5);
      const id = await seed('call', 100, startedAt, { voiceProviderConversationIds: ['conv_a'] });
      await sessionRepository.claimVoiceHold(id, startedAt);

      expect(await sessionRepository.appendVoiceProviderConversationId(id, startedAt, 'conv_b')).toBe(false);
      expect(await Session.findById(id).lean()).toMatchObject({ voiceProviderConversationIds: [] });
    });

    it("never attaches to a newer call's hold", async () => {
      const id = await seed('call', 100, minutesAgo(1), { voiceProviderConversationIds: ['conv_new'] });

      expect(await sessionRepository.appendVoiceProviderConversationId(id, minutesAgo(60), 'conv_old')).toBe(false);
      expect(await Session.findById(id).lean()).toMatchObject({ voiceProviderConversationIds: ['conv_new'] });
    });
  });
});
