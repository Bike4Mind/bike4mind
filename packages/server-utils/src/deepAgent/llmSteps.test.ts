import { describe, it, expect, vi } from 'vitest';
import type { SmallLLMAdapters } from '@bike4mind/common';
import type { ActContext, ActResult, Charter, DriveVector, Episode } from '@bike4mind/agents';
import { LlmWakeSteps } from './llmSteps';

const NEUTRAL: DriveVector = {
  curiosity: 0.5,
  progress: 0.5,
  social: 0.5,
  novelty: 0.5,
  caution: 0.5,
  aesthetic: 0.5,
};

const ISO = '2026-06-08T12:00:00.000Z';

function charter(overrides: Partial<Charter> = {}): Charter {
  return {
    identity: {
      agentId: 'agent-1',
      ownerUserId: 'owner-1',
      name: 'Reproducer',
      role: 'paper-repro',
      instantiatedAt: ISO,
      schemaVersion: 1,
    },
    goal: { description: 'Reproduce the target paper', successCriteria: ['DSF within 5%'], deadlineKind: 'none' },
    drives: { ...NEUTRAL },
    subgoals: [],
    semanticMemory: [],
    currentTier: 'engineering-proxy',
    openQuestions: [],
    blockers: [],
    sizeBudgetBytes: 8192,
    version: 1,
    updatedAt: ISO,
    ...overrides,
  };
}

/**
 * Fake backend: routes on the step marker present in the user prompt and replays
 * the matching canned JSON through the streaming callback.
 */
function fakeAdapters(responses: { orient: unknown; reflect: unknown; groom: unknown }): {
  adapters: SmallLLMAdapters;
  complete: ReturnType<typeof vi.fn>;
} {
  const complete = vi.fn(
    async (
      _model: string,
      messages: Array<{ role: string; content: string }>,
      _options: unknown,
      callback: (
        texts: (string | null | undefined)[],
        info?: { inputTokens?: number; outputTokens?: number }
      ) => Promise<void>
    ) => {
      const userText = messages.map(m => m.content).join('\n');
      const which = userText.includes('policy step')
        ? responses.orient
        : userText.includes('reflect step')
          ? responses.reflect
          : responses.groom;
      await callback([JSON.stringify(which)], { inputTokens: 10, outputTokens: 20 });
    }
  );
  return { adapters: { llm: { complete }, modelId: 'fake-model' }, complete };
}

const REFLECT_RESPONSE = {
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
};

function runActStub(): (ctx: ActContext) => Promise<ActResult> {
  return async () => ({ actionsTaken: [], observations: [], tokensSpent: 100, costUsd: 0.01 });
}

describe('LlmWakeSteps', () => {
  it('orient parses a PolicyDecision from the model', async () => {
    const { adapters } = fakeAdapters({
      orient: { actionKind: 'read_paper', rationale: 'curiosity high', expectedDriveDelta: { curiosity: 0.1 } },
      reflect: REFLECT_RESPONSE,
      groom: { semanticMemory: [], openQuestions: [] },
    });
    const steps = new LlmWakeSteps({ adapters, runAct: runActStub() });

    const policy = await steps.orient({ charter: charter(), handoff: null, recentEpisodes: [], drives: NEUTRAL });
    expect(policy.actionKind).toBe('read_paper');
    expect(policy.expectedDriveDelta.curiosity).toBe(0.1);
  });

  it('act delegates to the injected runAct', async () => {
    const { adapters } = fakeAdapters({ orient: {}, reflect: REFLECT_RESPONSE, groom: {} });
    const runAct = vi.fn(runActStub());
    const steps = new LlmWakeSteps({ adapters, runAct });

    const result = await steps.act({
      charter: charter(),
      policy: { actionKind: 'x', rationale: 'y', expectedDriveDelta: {} },
      drives: NEUTRAL,
    });
    expect(runAct).toHaveBeenCalledOnce();
    expect(result.tokensSpent).toBe(100);
  });

  it('reflect parses the full ReflectResult', async () => {
    const { adapters } = fakeAdapters({
      orient: {},
      reflect: REFLECT_RESPONSE,
      groom: { semanticMemory: [], openQuestions: [] },
    });
    const steps = new LlmWakeSteps({ adapters, runAct: runActStub() });

    const reflect = await steps.reflect({
      charter: charter(),
      policy: { actionKind: 'read_paper', rationale: 'x', expectedDriveDelta: {} },
      act: { actionsTaken: [], observations: [], tokensSpent: 0, costUsd: 0 },
      drives: NEUTRAL,
    });
    expect(reflect.scopeLocks).toContain('did NOT run experiments');
    expect(reflect.drivesAfter.curiosity).toBe(0.7);
    expect(reflect.nextIntendedAction).toBe('read methods');
  });

  it('tolerates small-model output: partial drives, malformed memory, object blockers', async () => {
    // Mirrors what Haiku actually returned in live testing: a partial drive
    // vector, a memory entry missing required fields, and a blocker as an
    // object instead of a string. None of this should fail.
    const { adapters } = fakeAdapters({
      orient: {},
      reflect: {
        reflection: 'r',
        summary: 's',
        nextIntendedAction: 'next',
        nextWakeIntervalMs: null, // explicit null (the exact bug) → dropped
        scopeLocks: null, // null instead of array → caught to []
        drivesAfter: { curiosity: 0.9, caution: 1.5 }, // partial + out of range
        addedSemanticMemory: [
          { fact: 'a real fact', evidenceTier: 'bogus-tier' }, // salvageable (tier defaulted)
          { confidence: 0.9 }, // unsalvageable (no fact) → dropped
        ],
        subgoalUpdates: [{ description: 'do the thing' }],
        openBlockers: [{ blocker: 'waiting on data' }, 'plain string blocker'],
      },
      groom: { semanticMemory: [], openQuestions: [] },
    });
    const steps = new LlmWakeSteps({ adapters, runAct: runActStub() });

    const WAKE_ISO = '2026-06-09T09:00:00.000Z';
    const reflect = await steps.reflect({
      charter: charter(),
      policy: { actionKind: 'x', rationale: 'y', expectedDriveDelta: {} },
      act: { actionsTaken: [], observations: [], tokensSpent: 0, costUsd: 0 },
      drives: NEUTRAL,
      nowIso: WAKE_ISO,
    });

    expect(reflect.drivesAfter.curiosity).toBe(0.9);
    expect(reflect.drivesAfter.caution).toBe(1); // clamped from 1.5
    expect(reflect.drivesAfter.progress).toBe(0.5); // untouched fallback
    expect(reflect.nextWakeIntervalMs).toBeUndefined(); // null dropped
    expect(reflect.scopeLocks).toEqual([]); // null caught to []
    expect(reflect.addedSemanticMemory).toHaveLength(1); // one salvaged, one dropped
    expect(reflect.addedSemanticMemory[0].fact).toBe('a real fact');
    expect(reflect.addedSemanticMemory[0].evidenceTier).toBe('engineering-proxy'); // charter tier fallback
    expect(reflect.addedSemanticMemory[0].lastAffirmedAt).toBe(WAKE_ISO); // wake clock, not wall clock
    expect(reflect.subgoalUpdates[0].description).toBe('do the thing');
    expect(reflect.openBlockers).toEqual(['waiting on data', 'plain string blocker']);
    expect(reflect.charterDiff.addedSemanticMemory).toEqual([reflect.addedSemanticMemory[0].id]);
  });

  it('groom replaces memory + questions but preserves identity and goal', async () => {
    const { adapters } = fakeAdapters({
      orient: {},
      reflect: REFLECT_RESPONSE,
      groom: {
        semanticMemory: [
          {
            id: 'm-merged',
            fact: 'consolidated fact',
            evidenceTier: 'engineering-proxy',
            confidence: 0.6,
            sourceEpisodeIds: [],
            lastAffirmedAt: ISO,
          },
        ],
        openQuestions: ['what next?'],
      },
    });
    const steps = new LlmWakeSteps({ adapters, runAct: runActStub() });

    const before = charter({ openQuestions: ['stale'], version: 9 });
    const recentEpisodes: Episode[] = [];
    const groomed = await steps.groom({ charter: before, recentEpisodes });

    expect(groomed.semanticMemory.map(m => m.id)).toEqual(['m-merged']);
    expect(groomed.openQuestions).toEqual(['what next?']);
    // identity + goal + version untouched by groom
    expect(groomed.identity).toEqual(before.identity);
    expect(groomed.goal).toEqual(before.goal);
    expect(groomed.version).toBe(9);
  });
});
