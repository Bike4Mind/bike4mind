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

async function seed(name: string, voiceReservedCredits: number | null, voiceSessionStartedAt: Date | null) {
  const now = new Date();
  const doc = await Session.create({
    name,
    userId: 'user-1',
    firstCreated: now,
    lastUpdated: now,
    voiceReservedCredits,
    voiceSessionStartedAt,
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
});
