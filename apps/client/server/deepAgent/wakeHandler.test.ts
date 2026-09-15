import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import {
  noopRunAct,
  type Charter,
  type DeepAgentStore,
  type DriveVector,
  type Episode,
  type Handoff,
  type PolicyDecision,
  type ReflectResult,
  type WakeDeps,
  type WakeSteps,
} from '@bike4mind/agents';
import { processWake, WakePayloadSchema } from './wakeHandler';

const NEUTRAL: DriveVector = {
  curiosity: 0.5,
  progress: 0.5,
  social: 0.5,
  novelty: 0.5,
  caution: 0.5,
  aesthetic: 0.5,
};
const ISO = '2026-06-08T12:00:00.000Z';

function charter(): Charter {
  return {
    identity: {
      agentId: 'agent-1',
      ownerUserId: 'owner-1',
      name: 'Reproducer',
      role: 'paper-repro',
      instantiatedAt: ISO,
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
    version: 1,
    updatedAt: ISO,
  };
}

class FakeStore implements DeepAgentStore {
  charters = new Map<string, Charter>();
  handoffs = new Map<string, Handoff>();
  episodes: Episode[] = [];
  async loadCharter(id: string) {
    return this.charters.get(id) ?? null;
  }
  async saveCharter(c: Charter) {
    this.charters.set(c.identity.agentId, c);
    return c;
  }
  async loadHandoff(id: string) {
    return this.handoffs.get(id) ?? null;
  }
  async saveHandoff(h: Handoff) {
    this.handoffs.set(h.agentId, h);
    return h;
  }
  async appendEpisode(e: Episode) {
    this.episodes.push(e);
    return e;
  }
  async recentEpisodes(id: string) {
    return this.episodes.filter(e => e.agentId === id);
  }
}

const POLICY: PolicyDecision = { actionKind: 'read_paper', rationale: 'x', expectedDriveDelta: {} };
const REFLECT: ReflectResult = {
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

const STEPS: WakeSteps = {
  async orient() {
    return POLICY;
  },
  act: noopRunAct,
  async reflect() {
    return REFLECT;
  },
  async groom(ctx) {
    return ctx.charter;
  },
};

function fakeDeps(store: FakeStore): WakeDeps {
  let n = 0;
  return { store, steps: STEPS, newEpisodeId: () => `ep-${++n}`, now: () => Date.parse(ISO) };
}

describe('WakePayloadSchema', () => {
  it('requires a non-empty agentId', () => {
    expect(WakePayloadSchema.safeParse({ agentId: '' }).success).toBe(false);
    expect(WakePayloadSchema.safeParse({ agentId: 'a' }).success).toBe(true);
  });
  it('accepts an optional modelId', () => {
    const parsed = WakePayloadSchema.parse({ agentId: 'a', modelId: 'us.anthropic.claude-haiku-4-5-20251001-v1:0' });
    expect(parsed.modelId).toContain('haiku');
  });
});

describe('noopRunAct', () => {
  it('returns a think-only act result with zero spend', async () => {
    const result = await noopRunAct({ charter: charter(), policy: POLICY, drives: NEUTRAL });
    expect(result.actionsTaken).toEqual([]);
    expect(result.tokensSpent).toBe(0);
    expect(result.observations[0].kind).toBe('noop');
  });
});

describe('processWake', () => {
  it('runs a wake cycle with injected deps and persists the episode + handoff', async () => {
    const store = new FakeStore();
    store.charters.set('agent-1', charter());
    const logger = new Logger();

    await processWake({ agentId: 'agent-1' }, logger, { deps: fakeDeps(store) });

    expect(store.episodes).toHaveLength(1);
    expect(store.handoffs.get('agent-1')?.wakeCount).toBe(1);
    expect(store.handoffs.get('agent-1')?.lastEpisodeId).toBe('ep-1');
    expect(store.charters.get('agent-1')?.version).toBe(2);
  });

  it('propagates a missing-charter error', async () => {
    const store = new FakeStore(); // no charter seeded
    const logger = new Logger();
    await expect(processWake({ agentId: 'ghost' }, logger, { deps: fakeDeps(store) })).rejects.toThrow(/no charter/i);
  });

  it('logs the wake outcome', async () => {
    const store = new FakeStore();
    store.charters.set('agent-1', charter());
    const logger = new Logger();
    const infoSpy = vi.spyOn(logger, 'info');

    await processWake({ agentId: 'agent-1' }, logger, { deps: fakeDeps(store) });

    expect(infoSpy).toHaveBeenCalledWith(
      'deep agent wake complete',
      expect.objectContaining({ agentId: 'agent-1', wakeCount: 1, episodeId: 'ep-1' })
    );
  });
});
