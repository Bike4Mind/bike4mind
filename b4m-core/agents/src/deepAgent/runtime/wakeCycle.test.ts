import { describe, it, expect, beforeEach } from 'vitest';
import type { Charter, DriveVector, Episode, Handoff, PolicyDecision } from '../schemas';
import { runWakeCycle, type WakeDeps } from './wakeCycle';
import type {
  ActContext,
  ActResult,
  DeepAgentStore,
  GroomContext,
  OrientContext,
  ReflectContext,
  ReflectResult,
  WakeSteps,
} from './types';

const NEUTRAL: DriveVector = {
  curiosity: 0.5,
  progress: 0.5,
  social: 0.5,
  novelty: 0.5,
  caution: 0.5,
  aesthetic: 0.5,
};

const T0 = Date.parse('2026-06-08T12:00:00.000Z');

function makeCharter(overrides: Partial<Charter> = {}): Charter {
  return {
    identity: {
      agentId: 'agent-1',
      ownerUserId: 'owner-1',
      name: 'Reproducer',
      role: 'paper-repro',
      instantiatedAt: new Date(T0 - 1000).toISOString(),
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
    version: 4,
    updatedAt: new Date(T0 - 1000).toISOString(),
    ...overrides,
  };
}

/** In-memory store; records the last-saved values for assertions. */
class FakeStore implements DeepAgentStore {
  charters = new Map<string, Charter>();
  handoffs = new Map<string, Handoff>();
  episodes: Episode[] = [];

  async loadCharter(agentId: string) {
    return this.charters.get(agentId) ?? null;
  }
  async saveCharter(charter: Charter) {
    this.charters.set(charter.identity.agentId, charter);
    return charter;
  }
  async loadHandoff(agentId: string) {
    return this.handoffs.get(agentId) ?? null;
  }
  async saveHandoff(handoff: Handoff) {
    this.handoffs.set(handoff.agentId, handoff);
    return handoff;
  }
  async appendEpisode(episode: Episode) {
    this.episodes.push(episode);
    return episode;
  }
  async recentEpisodes(agentId: string, limit = 10) {
    return this.episodes
      .filter(e => e.agentId === agentId)
      .sort((a, b) => Date.parse(b.wakeAt) - Date.parse(a.wakeAt))
      .slice(0, limit);
  }
}

/** Deterministic steps; reflect output is overridable per test. */
function makeSteps(reflectOverride: Partial<ReflectResult> = {}): WakeSteps & { groomCalls: number } {
  const policy: PolicyDecision = {
    actionKind: 'read_paper',
    rationale: 'curiosity is high',
    expectedDriveDelta: {},
  };
  const steps = {
    groomCalls: 0,
    async orient(_ctx: OrientContext) {
      return policy;
    },
    async act(_ctx: ActContext): Promise<ActResult> {
      return { actionsTaken: [], observations: [], tokensSpent: 100, costUsd: 0.01 };
    },
    async reflect(_ctx: ReflectContext): Promise<ReflectResult> {
      return {
        reflection: 'read the abstract',
        summary: 'read the abstract',
        nextIntendedAction: 'read methods',
        scopeLocks: ['did NOT run experiments'],
        drivesAfter: { ...NEUTRAL, curiosity: 0.7 },
        charterDiff: {
          addedSemanticMemory: [],
          removedSemanticMemoryIds: [],
          subgoalStatusChanges: [],
          summary: 'no change',
        },
        addedSemanticMemory: [],
        removedSemanticMemoryIds: [],
        subgoalUpdates: [],
        openBlockers: [],
        ...reflectOverride,
      };
    },
    async groom(ctx: GroomContext): Promise<Charter> {
      steps.groomCalls += 1;
      // Pretend grooming compacted memory and raised the budget headroom.
      return { ...ctx.charter, semanticMemory: [], sizeBudgetBytes: 8192 };
    },
  };
  return steps;
}

function baseDeps(store: FakeStore, steps: WakeSteps): WakeDeps {
  let n = 0;
  return {
    store,
    steps,
    newEpisodeId: () => `ep-${++n}`,
    now: () => T0,
  };
}

describe('runWakeCycle', () => {
  let store: FakeStore;

  beforeEach(() => {
    store = new FakeStore();
  });

  it('throws when the agent has no charter', async () => {
    await expect(runWakeCycle('ghost', baseDeps(store, makeSteps()))).rejects.toThrow(/no charter/i);
  });

  it('persists an episode capturing the wake (first wake, no handoff)', async () => {
    store.charters.set('agent-1', makeCharter());
    const outcome = await runWakeCycle('agent-1', baseDeps(store, makeSteps()));

    expect(store.episodes).toHaveLength(1);
    const ep = store.episodes[0];
    expect(ep.id).toBe('ep-1');
    expect(ep.wakeAt).toBe(new Date(T0).toISOString());
    expect(ep.evidenceTier).toBe('engineering-proxy'); // from charter.currentTier
    expect(ep.scopeLocks).toContain('did NOT run experiments');
    expect(ep.tokensSpent).toBe(100);
    expect(outcome.episode.id).toBe('ep-1');
    expect(outcome.groomed).toBe(false);
  });

  it('increments wakeCount and links the latest episode in the handoff', async () => {
    store.charters.set('agent-1', makeCharter());
    store.handoffs.set('agent-1', {
      agentId: 'agent-1',
      wakeCount: 6,
      lastWakeAt: new Date(T0 - 60_000).toISOString(),
      lastActionSummary: 'prev',
      nextIntendedAction: 'next',
      openBlockers: [],
      updatedAt: new Date(T0 - 60_000).toISOString(),
    });

    const outcome = await runWakeCycle('agent-1', baseDeps(store, makeSteps()));
    expect(outcome.handoff.wakeCount).toBe(7);
    expect(outcome.handoff.lastEpisodeId).toBe('ep-1');
    expect(outcome.handoff.lastActionSummary).toBe('read the abstract');
    expect(outcome.handoff.nextIntendedAction).toBe('read methods');
  });

  it('bumps the charter version exactly once and writes back drivesAfter', async () => {
    store.charters.set('agent-1', makeCharter({ version: 4 }));
    const outcome = await runWakeCycle('agent-1', baseDeps(store, makeSteps()));
    expect(outcome.charter.version).toBe(5);
    expect(outcome.charter.drives.curiosity).toBe(0.7);
    expect(outcome.charter.updatedAt).toBe(new Date(T0).toISOString());
  });

  it('decays drives by elapsed time before the policy step', async () => {
    // curiosity default half-life is 2h; start at 1.0, wake exactly 2h later.
    store.charters.set('agent-1', makeCharter({ drives: { ...NEUTRAL, curiosity: 1.0 } }));
    store.handoffs.set('agent-1', {
      agentId: 'agent-1',
      wakeCount: 1,
      lastWakeAt: new Date(T0 - 2 * 60 * 60 * 1000).toISOString(),
      lastActionSummary: '',
      nextIntendedAction: '',
      openBlockers: [],
      updatedAt: new Date(T0 - 2 * 60 * 60 * 1000).toISOString(),
    });

    await runWakeCycle('agent-1', baseDeps(store, makeSteps()));
    expect(store.episodes[0].drivesBefore.curiosity).toBeCloseTo(0.5, 5);
  });

  it('clamps LLM-proposed drive jumps to MAX_DRIVE_DELTA_PER_WAKE (math owns the vector)', async () => {
    store.charters.set('agent-1', makeCharter());
    // Reflect proposes a wild jump: curiosity 0.5 -> 1.0 (Δ+0.5) and caution
    // 0.5 -> 0.0 (Δ-0.5). Both must be clamped to ±0.25.
    const steps = makeSteps({ drivesAfter: { ...NEUTRAL, curiosity: 1.0, caution: 0.0 } });
    const outcome = await runWakeCycle('agent-1', baseDeps(store, steps));
    expect(outcome.episode.drivesAfter.curiosity).toBeCloseTo(0.75, 10);
    expect(outcome.episode.drivesAfter.caution).toBeCloseTo(0.25, 10);
    expect(outcome.charter.drives.curiosity).toBeCloseTo(0.75, 10);
  });

  it('stamps added memory with the producing episode id and the wake timestamp', async () => {
    store.charters.set('agent-1', makeCharter());
    const steps = makeSteps({
      addedSemanticMemory: [
        {
          id: 'm-new',
          fact: 'a discovered fact',
          evidenceTier: 'engineering-proxy',
          confidence: 0.6,
          sourceEpisodeIds: [], // model left provenance empty — orchestrator must stamp
          lastAffirmedAt: new Date(T0 - 99_999).toISOString(),
        },
      ],
    });
    const outcome = await runWakeCycle('agent-1', baseDeps(store, steps));
    const entry = outcome.charter.semanticMemory.find(m => m.id === 'm-new');
    expect(entry?.sourceEpisodeIds).toEqual([outcome.episode.id]);
    expect(entry?.lastAffirmedAt).toBe(new Date(T0).toISOString());
  });

  it('deduplicates memory ids — an added entry with an existing id replaces it', async () => {
    store.charters.set(
      'agent-1',
      makeCharter({
        semanticMemory: [
          {
            id: 'm-1',
            fact: 'old version of the fact',
            evidenceTier: 'engineering-proxy',
            confidence: 0.4,
            sourceEpisodeIds: ['ep-old'],
            lastAffirmedAt: new Date(T0 - 1000).toISOString(),
          },
        ],
      })
    );
    const steps = makeSteps({
      addedSemanticMemory: [
        {
          id: 'm-1', // collides with existing — must replace, not duplicate
          fact: 'updated fact',
          evidenceTier: 'engineering-scaled',
          confidence: 0.8,
          sourceEpisodeIds: [],
          lastAffirmedAt: new Date(T0).toISOString(),
        },
      ],
    });
    const outcome = await runWakeCycle('agent-1', baseDeps(store, steps));
    const matches = outcome.charter.semanticMemory.filter(m => m.id === 'm-1');
    expect(matches).toHaveLength(1);
    expect(matches[0].fact).toBe('updated fact');
  });

  it('applies semantic-memory additions and removals from reflect', async () => {
    store.charters.set(
      'agent-1',
      makeCharter({
        semanticMemory: [
          {
            id: 'm-old',
            fact: 'stale fact',
            evidenceTier: 'engineering-proxy',
            confidence: 0.5,
            sourceEpisodeIds: [],
            lastAffirmedAt: new Date(T0 - 1000).toISOString(),
          },
        ],
      })
    );
    const steps = makeSteps({
      removedSemanticMemoryIds: ['m-old'],
      addedSemanticMemory: [
        {
          id: 'm-new',
          fact: 'KCuF3 is a 1D antiferromagnet',
          evidenceTier: 'external-facing',
          confidence: 0.8,
          sourceEpisodeIds: ['ep-1'],
          lastAffirmedAt: new Date(T0).toISOString(),
        },
      ],
    });

    const outcome = await runWakeCycle('agent-1', baseDeps(store, steps));
    const ids = outcome.charter.semanticMemory.map(m => m.id);
    expect(ids).toEqual(['m-new']);
  });

  it('grooms when the post-mutation charter is over budget', async () => {
    // Tiny budget any real charter exceeds -> groom must run.
    store.charters.set('agent-1', makeCharter({ sizeBudgetBytes: 50 }));
    const steps = makeSteps();

    const outcome = await runWakeCycle('agent-1', baseDeps(store, steps));
    expect(steps.groomCalls).toBe(1);
    expect(outcome.groomed).toBe(true);
    expect(outcome.charter.groomedAt).toBe(new Date(T0).toISOString());
    expect(outcome.charter.version).toBe(5); // still a single bump
  });

  it('does not groom when the charter is within budget', async () => {
    store.charters.set('agent-1', makeCharter({ sizeBudgetBytes: 8192 }));
    const steps = makeSteps();
    const outcome = await runWakeCycle('agent-1', baseDeps(store, steps));
    expect(steps.groomCalls).toBe(0);
    expect(outcome.groomed).toBe(false);
    expect(outcome.charter.groomedAt).toBeUndefined();
  });
});
