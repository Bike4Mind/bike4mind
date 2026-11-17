import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import mongoose from 'mongoose';
import type { MongoMemoryServer } from 'mongodb-memory-server';
import { deepAgentHandoffRepository, User } from '@bike4mind/database';
import { Logger } from '@bike4mind/observability';
import { noopRunAct, type Charter, type DriveVector, type WakeDeps, type WakeSteps } from '@bike4mind/agents';
import { createMongoServer, MONGO_TEST_TIMEOUT_MS } from '../../../../packages/database/src/__test__/createMongoServer';

const credits = vi.hoisted(() => ({ enforced: true }));
vi.mock('@bike4mind/server-utils/billing/meterPlatformCompletion', async importOriginal => ({
  ...(await importOriginal<typeof import('@bike4mind/server-utils/billing/meterPlatformCompletion')>()),
  isCreditsEnforced: async () => credits.enforced,
}));

import { MongoDeepAgentStore } from '@bike4mind/server-utils/deepAgent/store';
import { MISSION_OWNER_RESTRICTED_BLOCKER } from '@bike4mind/server-utils/deepAgent/wakeMetering';
import { processWake } from './wakeHandler';

vi.setConfig({ testTimeout: MONGO_TEST_TIMEOUT_MS, hookTimeout: MONGO_TEST_TIMEOUT_MS });

let server: MongoMemoryServer;

beforeAll(async () => {
  server = await createMongoServer();
  await mongoose.connect(server.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await server?.stop();
});

afterEach(async () => {
  await mongoose.connection.db!.dropDatabase();
  credits.enforced = true;
});

const NEUTRAL: DriveVector = { curiosity: 0.5, progress: 0.5, social: 0.5, novelty: 0.5, caution: 0.5, aesthetic: 0.5 };
const INTERVAL_MS = 6 * 60 * 60 * 1000;
const AGENT_ID = 'mission-1';

async function seedMission(
  userFields: Record<string, unknown>,
  openBlockers: string[] = [],
  opts: { withHandoff?: boolean; lastWakeAt?: string } = {}
) {
  const owner = await User.create({
    username: 'owner',
    email: 'owner@example.com',
    name: 'Owner',
    ...userFields,
  });
  const store = new MongoDeepAgentStore();
  const now = new Date().toISOString();
  const charter: Charter = {
    identity: {
      agentId: AGENT_ID,
      ownerUserId: String(owner._id),
      name: 'Reproducer',
      role: 'paper-repro',
      instantiatedAt: now,
      schemaVersion: 1,
    },
    goal: { description: 'Reproduce the target paper', successCriteria: [], deadlineKind: 'none' },
    drives: { ...NEUTRAL },
    subgoals: [],
    semanticMemory: [],
    currentTier: 'engineering-proxy',
    openQuestions: [],
    blockers: [],
    sizeBudgetBytes: 8192,
    version: 0,
    updatedAt: now,
  };
  await store.saveCharter(charter);
  if (opts.withHandoff === false) return store;
  await store.saveHandoff({
    agentId: AGENT_ID,
    wakeCount: 2,
    lastWakeAt: opts.lastWakeAt ?? now,
    lastActionSummary: 'read the paper',
    nextIntendedAction: 'reproduce table 1',
    nextWakeIntervalMs: INTERVAL_MS,
    openBlockers,
    updatedAt: now,
  });
  return store;
}

function wakeDeps(store: MongoDeepAgentStore) {
  const providerCalls = vi.fn();
  const steps: WakeSteps = {
    async orient() {
      providerCalls();
      return { actionKind: 'read_paper', rationale: 'x', expectedDriveDelta: {} };
    },
    act: noopRunAct,
    async reflect() {
      providerCalls();
      return {
        reflection: 'r',
        summary: 's',
        nextIntendedAction: 'next',
        scopeLocks: [],
        drivesAfter: NEUTRAL,
        charterDiff: { addedSemanticMemory: [], removedSemanticMemoryIds: [], subgoalStatusChanges: [], summary: 'd' },
        addedSemanticMemory: [],
        removedSemanticMemoryIds: [],
        subgoalUpdates: [],
        openBlockers: [],
      };
    },
    async groom(ctx) {
      return ctx.charter;
    },
  };
  let n = 0;
  const deps: WakeDeps = { store, steps, newEpisodeId: () => `ep-${++n}` };
  return { deps, providerCalls };
}

const BLOCKED_STATES: Array<[string, Record<string, unknown>]> = [
  ['banned', { isBanned: true }],
  ['dispute pending', { disputePending: true }],
  ['suspended', { moderation: { status: 'suspended' } }],
  ['AI access revoked', { isModerated: true }],
  [
    'scheduled for deletion',
    { deletion: { requestedAt: new Date(), scheduledFor: new Date(Date.now() + 86_400_000), source: 'self' } },
  ],
  ['signup review pending', { riskScore: { score: 80, computedAt: new Date(), reviewState: 'pending' } }],
];

describe('processWake account-standing gate (real user documents)', () => {
  describe.each([true, false])('with credits enforced=%s', enforced => {
    it.each(BLOCKED_STATES)('holds the wake for a %s owner without calling the model', async (_label, fields) => {
      credits.enforced = enforced;
      const store = await seedMission(fields);
      const { deps, providerCalls } = wakeDeps(store);
      const before = Date.now();

      await processWake({ agentId: AGENT_ID }, new Logger(), { deps });

      expect(providerCalls).not.toHaveBeenCalled();
      expect(await store.recentEpisodes(AGENT_ID, 10)).toHaveLength(0);
      const handoff = await store.loadHandoff(AGENT_ID);
      expect(handoff?.openBlockers).toEqual([MISSION_OWNER_RESTRICTED_BLOCKER]);
      expect(handoff?.nextWakeIntervalMs).toBe(INTERVAL_MS);
      expect(handoff?.wakeCount).toBe(2);
      const doc = await deepAgentHandoffRepository.findByAgentId(AGENT_ID);
      const nextWakeAt = doc!.nextWakeAt!.getTime();
      expect(nextWakeAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);
      expect(nextWakeAt).toBeLessThanOrEqual(Date.now() + 60 * 60 * 1000);
    });
  });

  it('wakes a healthy owner and clears a stale account blocker', async () => {
    const store = await seedMission({}, [MISSION_OWNER_RESTRICTED_BLOCKER]);
    const { deps, providerCalls } = wakeDeps(store);

    await processWake({ agentId: AGENT_ID }, new Logger(), { deps });

    expect(providerCalls).toHaveBeenCalled();
    expect(await store.recentEpisodes(AGENT_ID, 10)).toHaveLength(1);
    const handoff = await store.loadHandoff(AGENT_ID);
    expect(handoff?.openBlockers).not.toContain(MISSION_OWNER_RESTRICTED_BLOCKER);
    expect(handoff?.wakeCount).toBe(3);
  });

  it('keeps the cron claim lease while clearing a stale blocker on a due wake', async () => {
    const store = await seedMission({}, [MISSION_OWNER_RESTRICTED_BLOCKER], {
      lastWakeAt: new Date(Date.now() - 2 * INTERVAL_MS).toISOString(),
    });
    const leaseMs = 15 * 60 * 1000;
    const claimedAt = Date.now();
    expect(await deepAgentHandoffRepository.claimDueAgentIds(new Date(claimedAt), leaseMs)).toEqual([AGENT_ID]);
    const { deps } = wakeDeps(store);
    const orient = deps.steps.orient.bind(deps.steps);
    let nextWakeAtDuringWake: Date | undefined;
    deps.steps.orient = async ctx => {
      nextWakeAtDuringWake = (await deepAgentHandoffRepository.findByAgentId(AGENT_ID))?.nextWakeAt;
      return orient(ctx);
    };

    await processWake({ agentId: AGENT_ID }, new Logger(), { deps });

    expect(nextWakeAtDuringWake?.getTime()).toBe(claimedAt + leaseMs);
    expect(await deepAgentHandoffRepository.claimDueAgentIds(new Date(), leaseMs)).toEqual([]);
  });

  it('holds and reschedules a mission restricted before its first wake, then wakes it once lifted', async () => {
    const store = await seedMission({ isModerated: true }, [], { withHandoff: false });
    const { deps, providerCalls } = wakeDeps(store);
    const before = Date.now();

    await processWake({ agentId: AGENT_ID }, new Logger(), { deps });

    expect(providerCalls).not.toHaveBeenCalled();
    const held = await store.loadHandoff(AGENT_ID);
    expect(held).toMatchObject({ wakeCount: 0, openBlockers: [MISSION_OWNER_RESTRICTED_BLOCKER] });
    const nextWakeAt = (await deepAgentHandoffRepository.findByAgentId(AGENT_ID))!.nextWakeAt!.getTime();
    expect(nextWakeAt).toBeGreaterThanOrEqual(before + 60 * 60 * 1000);

    await processWake({ agentId: AGENT_ID }, new Logger(), { deps });
    expect(providerCalls).not.toHaveBeenCalled();

    await User.updateOne({}, { $set: { isModerated: false } });
    await processWake({ agentId: AGENT_ID }, new Logger(), { deps });

    expect(providerCalls).toHaveBeenCalled();
    const woken = await store.loadHandoff(AGENT_ID);
    expect(woken?.wakeCount).toBe(1);
    expect(woken?.openBlockers).not.toContain(MISSION_OWNER_RESTRICTED_BLOCKER);
  });
});
