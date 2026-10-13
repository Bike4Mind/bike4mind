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
  await Session.deleteMany({});
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60 * 1000);

async function seed(
  name: string,
  voiceReservedCredits: number | null,
  voiceSessionStartedAt: Date | null,
  voiceBilledCredits?: number
) {
  const now = new Date();
  const doc = await Session.create({
    name,
    userId: 'user-1',
    firstCreated: now,
    lastUpdated: now,
    voiceReservedCredits,
    voiceSessionStartedAt,
    ...(voiceBilledCredits === undefined ? {} : { voiceBilledCredits }),
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

    const holds = await sessionRepository.findStaleVoiceHolds(minutesAgo(30), minutesAgo(30), 2);

    expect(holds.map(h => h.id)).toEqual([oldest, older]);
    expect(holds[0]).toMatchObject({ userId: 'user-1', voiceReservedCredits: 100, realtime: false });
    expect(holds[0].voiceSessionStartedAt).toBeInstanceOf(Date);
  });

  it('holds a realtime hold (billed per response) to its own, later cutoff', async () => {
    const elevenLabs = await seed('elevenlabs', 100, minutesAgo(45));
    await seed('live-realtime', 100, minutesAgo(45), 30);
    const staleRealtime = await seed('stale-realtime', 100, minutesAgo(90), 0);

    const holds = await sessionRepository.findStaleVoiceHolds(minutesAgo(30), minutesAgo(70), 10);

    expect(holds.map(h => [h.id, h.realtime])).toEqual([
      [staleRealtime, true],
      [elevenLabs, false],
    ]);
  });

  it('lets exactly one concurrent claim win and clears the hold', async () => {
    const startedAt = minutesAgo(60);
    const id = await seed('call', 100, startedAt);

    const results = await Promise.all([
      sessionRepository.claimVoiceHold(id, startedAt),
      sessionRepository.claimVoiceHold(id, startedAt),
    ]);

    expect(results.filter(Boolean)).toEqual([{ billedCredits: null }]);
    const after = await Session.findById(id).lean();
    expect(after).toMatchObject({ voiceReservedCredits: null, voiceSessionStartedAt: null });
  });

  it('with realtimeOnly, claims a realtime hold but leaves an ElevenLabs hold untouched', async () => {
    const startedAt = minutesAgo(5);
    const elevenLabs = await seed('elevenlabs', 100, startedAt);
    const realtime = await seed('realtime', 100, startedAt, 30);

    expect(await sessionRepository.claimVoiceHold(elevenLabs, startedAt, { realtimeOnly: true })).toBeNull();
    expect(await Session.findById(elevenLabs).lean()).toMatchObject({
      voiceReservedCredits: 100,
      voiceSessionStartedAt: startedAt,
    });

    expect(await sessionRepository.claimVoiceHold(realtime, startedAt, { realtimeOnly: true })).toEqual({
      billedCredits: 30,
    });
    expect(await Session.findById(realtime).lean()).toMatchObject({
      voiceReservedCredits: null,
      voiceSessionStartedAt: null,
    });
  });

  it("never claims a newer call's hold with a stale start time", async () => {
    const id = await seed('call', 100, minutesAgo(1));

    expect(await sessionRepository.claimVoiceHold(id, minutesAgo(60))).toBeNull();
    expect(await Session.findById(id).lean()).toMatchObject({ voiceReservedCredits: 100 });
  });

  it('restores a claimed hold, but never over a newer call', async () => {
    const startedAt = minutesAgo(60);
    const id = await seed('call', 100, startedAt, 40);
    const claimed = await sessionRepository.claimVoiceHold(id, startedAt);

    expect(await sessionRepository.restoreVoiceHold(id, 100, startedAt, claimed!.billedCredits)).toBe(true);
    expect(await Session.findById(id).lean()).toMatchObject({
      voiceReservedCredits: 100,
      voiceSessionStartedAt: startedAt,
      voiceBilledCredits: 40,
    });

    // The hold is live again, so a second restore (standing in for a newer call's hold) must not overwrite it.
    expect(await sessionRepository.restoreVoiceHold(id, 999, minutesAgo(1), null)).toBe(false);
    expect(await Session.findById(id).lean()).toMatchObject({ voiceReservedCredits: 100 });
  });
});
