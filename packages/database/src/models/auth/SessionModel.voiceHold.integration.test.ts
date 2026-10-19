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

  it('lets exactly one of two concurrent bootstraps open its hold over the same prior state', async () => {
    const id = await seed('call', null, null);
    const first = minutesAgo(0);
    const second = new Date(first.getTime() + 1);

    const results = await Promise.all([
      sessionRepository.openVoiceHold(id, null, {
        voiceReservedCredits: 100,
        voiceSessionStartedAt: first,
        realtime: false,
      }),
      sessionRepository.openVoiceHold(id, null, {
        voiceReservedCredits: 100,
        voiceSessionStartedAt: second,
        realtime: false,
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const after = await Session.findById(id).lean();
    expect(after?.voiceSessionStartedAt).toEqual(results[0] ? first : second);
  });

  it('does not open over a reserved hold restored at the start the bootstrap read', async () => {
    const prior = minutesAgo(5);
    const id = await seed('call', 100, prior);

    expect(
      await sessionRepository.openVoiceHold(id, prior, {
        voiceReservedCredits: 100,
        voiceSessionStartedAt: minutesAgo(0),
        realtime: false,
      })
    ).toBe(false);
    const after = await Session.findById(id).lean();
    expect(after).toMatchObject({ voiceReservedCredits: 100, voiceSessionStartedAt: prior });
  });

  it('opens over an unclaimed no-reserve prior hold, and drops its realtime marker for an ElevenLabs hold', async () => {
    const prior = minutesAgo(5);
    const id = await seed('call', null, prior, 0);
    const startedAt = minutesAgo(0);

    expect(
      await sessionRepository.openVoiceHold(id, prior, {
        voiceReservedCredits: 100,
        voiceSessionStartedAt: startedAt,
        realtime: false,
      })
    ).toBe(true);
    const after = await Session.findById(id).lean();
    expect(after).toMatchObject({
      voiceReservedCredits: 100,
      voiceSessionStartedAt: startedAt,
      voiceConnectedAt: null,
    });
    expect(after).not.toHaveProperty('voiceBilledCredits');
  });

  it('gives a realtime hold the billed-credits marker, and never opens over a newer hold', async () => {
    const id = await seed('call', 100, minutesAgo(1));

    expect(
      await sessionRepository.openVoiceHold(id, null, {
        voiceReservedCredits: 100,
        voiceSessionStartedAt: new Date(),
        realtime: true,
      })
    ).toBe(false);
    await Session.updateOne({ _id: id }, { $set: { voiceSessionStartedAt: null } });
    expect(
      await sessionRepository.openVoiceHold(id, null, {
        voiceReservedCredits: 50,
        voiceSessionStartedAt: new Date(),
        realtime: true,
      })
    ).toBe(true);
    expect(await Session.findById(id).lean()).toMatchObject({ voiceReservedCredits: 50, voiceBilledCredits: 0 });
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

    const connectedAt = minutesAgo(59);
    expect(
      await sessionRepository.restoreVoiceHold(id, 100, startedAt, {
        voiceConnectedAt: connectedAt,
        voiceBilledCredits: claimed!.billedCredits,
      })
    ).toBe(true);
    expect(await Session.findById(id).lean()).toMatchObject({
      voiceReservedCredits: 100,
      voiceSessionStartedAt: startedAt,
      voiceConnectedAt: connectedAt,
      voiceBilledCredits: 40,
    });

    // The hold is live again, so a second restore (standing in for a newer call's hold) must not overwrite it.
    expect(await sessionRepository.restoreVoiceHold(id, 999, minutesAgo(1))).toBe(false);
    expect(await Session.findById(id).lean()).toMatchObject({ voiceReservedCredits: 100 });
  });

  it('marks a hold connected once and keeps its latest activity', async () => {
    const id = await seed('call', 100, minutesAgo(10));
    const first = minutesAgo(9);
    const later = minutesAgo(5);

    await sessionRepository.recordVoiceActivity(id, first);
    await sessionRepository.recordVoiceActivity(id, later);
    // A delayed report from earlier must not move either marker back.
    await sessionRepository.recordVoiceActivity(id, minutesAgo(8));

    const after = await Session.findById(id).lean();
    expect(after?.voiceConnectedAt).toEqual(first);
    expect(after?.voiceLastActivityAt).toEqual(later);
    const [stale] = await sessionRepository.findStaleVoiceHolds(new Date(), new Date(), 1);
    expect(stale).toMatchObject({ voiceConnectedAt: first, voiceLastActivityAt: later });
  });

  it('leaves a newer hold untouched by activity from the hold it replaced', async () => {
    const oldStart = minutesAgo(10);
    const newStart = minutesAgo(2);
    const id = await seed('call', 100, newStart);

    // A reconnect's token names the replaced hold, so the proxy sees no match and refuses the turn (402).
    expect(await sessionRepository.recordVoiceActivity(id, minutesAgo(1), oldStart)).toBe(false);
    expect(await Session.findById(id).lean()).toMatchObject({ voiceConnectedAt: null, voiceLastActivityAt: null });

    const at = minutesAgo(1);
    await sessionRepository.recordVoiceActivity(id, at, newStart);
    expect(await Session.findById(id).lean()).toMatchObject({ voiceConnectedAt: at, voiceLastActivityAt: at });
  });

  it('reports whether it matched an open hold with the named start', async () => {
    const startedAt = minutesAgo(10);
    const id = await seed('call', 100, startedAt);

    expect(await sessionRepository.recordVoiceActivity(id, minutesAgo(9), startedAt)).toBe(true);
    expect(await sessionRepository.recordVoiceActivity(id, minutesAgo(8))).toBe(true);
    expect(await sessionRepository.recordVoiceActivity(id, minutesAgo(8), minutesAgo(20))).toBe(false);

    await sessionRepository.claimVoiceHold(id, startedAt);
    expect(await sessionRepository.recordVoiceActivity(id, minutesAgo(1), startedAt)).toBe(false);
    expect(await sessionRepository.recordVoiceActivity(id, minutesAgo(1))).toBe(false);
  });

  it('marks only a realtime hold when asked for realtimeOnly', async () => {
    const elevenLabs = await seed('elevenlabs', 100, minutesAgo(10));
    const realtime = await seed('realtime', 100, minutesAgo(10), 0);
    const at = minutesAgo(1);

    expect(await sessionRepository.recordVoiceActivity(elevenLabs, at, null, { realtimeOnly: true })).toBe(false);
    expect(await sessionRepository.recordVoiceActivity(realtime, at, null, { realtimeOnly: true })).toBe(true);

    expect(await Session.findById(elevenLabs).lean()).toMatchObject({
      voiceConnectedAt: null,
      voiceLastActivityAt: null,
    });
    expect(await Session.findById(realtime).lean()).toMatchObject({ voiceConnectedAt: at, voiceLastActivityAt: at });
  });

  it('records no activity without an open hold, and a claim clears the markers', async () => {
    const startedAt = minutesAgo(10);
    const id = await seed('call', 100, startedAt);
    await sessionRepository.recordVoiceActivity(id, minutesAgo(9));

    await sessionRepository.claimVoiceHold(id, startedAt);
    await sessionRepository.recordVoiceActivity(id, minutesAgo(1));

    expect(await Session.findById(id).lean()).toMatchObject({ voiceConnectedAt: null, voiceLastActivityAt: null });
  });
});

describe('stale voice hold sweep index', () => {
  it('serves the real findStaleVoiceHolds query from the partial open-hold index', async () => {
    await Session.init();
    for (let i = 0; i < 40; i++) {
      await seed(`idle-${i}`, null, null);
      await seed(`hold-${i}`, 100, minutesAgo(60 + i), i % 2 === 0 ? 0 : undefined);
    }

    // Capture the filter the repository actually sends (soft-delete plugin included), so the
    // assertion cannot drift from the query it is meant to pin.
    let filter: Record<string, unknown> | undefined;
    mongoose.set('debug', (_collection: string, method: string, query: Record<string, unknown>) => {
      if (method === 'find') filter = query;
    });
    try {
      await sessionRepository.findStaleVoiceHolds(minutesAgo(30), minutesAgo(30), 200);
    } finally {
      mongoose.set('debug', false);
    }
    expect(filter).toBeDefined();

    const explain = await Session.collection
      .find(filter as Record<string, unknown>)
      .sort({ voiceSessionStartedAt: 1 })
      .limit(200)
      .explain('queryPlanner');
    const indexNames: string[] = [];
    const walk = (stage: { indexName?: string; inputStage?: unknown; inputStages?: unknown[] } | undefined) => {
      if (!stage) return;
      if (stage.indexName) indexNames.push(stage.indexName);
      walk(stage.inputStage as typeof stage);
      stage.inputStages?.forEach(child => walk(child as typeof stage));
    };
    walk(explain.queryPlanner.winningPlan);

    expect(indexNames.length).toBeGreaterThan(0);
    expect(new Set(indexNames)).toEqual(new Set(['voiceSessionStartedAt_1_openVoiceHold']));
  });
});
