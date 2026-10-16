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

async function seedHold(startedAt: Date, voiceBilledCredits?: number) {
  const now = new Date();
  const doc = await Session.create({
    name: 'call',
    userId: 'user-1',
    firstCreated: now,
    lastUpdated: now,
    voiceReservedCredits: 100,
    voiceSessionStartedAt: startedAt,
    ...(voiceBilledCredits === undefined ? {} : { voiceBilledCredits }),
  });
  return doc.id as string;
}

describe('sessionRepository realtime voice billing', () => {
  it('accumulates billed credits against the open hold and reports the prior total', async () => {
    const startedAt = new Date();
    const id = await seedHold(startedAt, 0);

    expect(await sessionRepository.addVoiceBilledCredits(id, startedAt, 30)).toBe(0);
    expect(await sessionRepository.addVoiceBilledCredits(id, startedAt, 20)).toBe(30);
    expect((await Session.findById(id).lean())?.voiceBilledCredits).toBe(50);
  });

  it('never bills a response against a hold opened without the realtime marker', async () => {
    const startedAt = new Date();
    const id = await seedHold(startedAt);

    expect(await sessionRepository.addVoiceBilledCredits(id, startedAt, 30)).toBeNull();
    expect((await Session.findById(id).lean())?.voiceBilledCredits).toBeUndefined();
  });

  it('claims a hold exactly once, reports what was billed and clears the billing state', async () => {
    const startedAt = new Date();
    const id = await seedHold(startedAt, 40);

    const results = await Promise.all([
      sessionRepository.claimVoiceHold(id, startedAt),
      sessionRepository.claimVoiceHold(id, startedAt),
    ]);

    expect(results.filter(Boolean)).toEqual([{ billedCredits: 40, payerId: null }]);
    const after = await Session.findById(id).lean();
    expect(after).toMatchObject({ voiceReservedCredits: null, voiceSessionStartedAt: null });
    expect(after?.voiceBilledCredits).toBeUndefined();
    expect(await sessionRepository.addVoiceBilledCredits(id, startedAt, 10)).toBeNull();
  });

  it("never touches a newer call's hold", async () => {
    const id = await seedHold(new Date(), 0);
    const stale = new Date(Date.now() - 60 * 60 * 1000);

    expect(await sessionRepository.addVoiceBilledCredits(id, stale, 10)).toBeNull();
    expect(await sessionRepository.claimVoiceHold(id, stale)).toBeNull();
  });
});
