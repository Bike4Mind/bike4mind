import { describe, it, expect } from 'vitest';
import type { ICompletionBackend } from '@bike4mind/llm-adapters';
import type { Charter, DriveVector, Episode, Handoff } from '../schemas';
import { createBackendWakeSteps } from './referenceWakeSteps';
import { runWakeCycle } from './wakeCycle';
import type { DeepAgentStore } from './types';

const NEUTRAL: DriveVector = {
  curiosity: 0.5,
  progress: 0.5,
  social: 0.5,
  novelty: 0.5,
  caution: 0.5,
  aesthetic: 0.5,
};

const T0 = Date.parse('2026-06-08T12:00:00.000Z');

function makeCharter(): Charter {
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
  };
}

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
      .slice(-limit)
      .reverse();
  }
}

/**
 * Minimal `ICompletionBackend` whose `complete` returns canned JSON keyed off
 * which reference prompt it sees. Only `complete` is exercised by the reference
 * WakeSteps, so the rest of the interface is intentionally absent.
 */
function fakeBackend(responder: (prompt: string) => string): ICompletionBackend {
  return {
    async complete(_model, messages, _options, callback) {
      const prompt = String(messages[0]?.content ?? '');
      await callback([responder(prompt)], undefined);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test fake: only complete() is used
  } as any;
}

describe('createBackendWakeSteps (reference tier)', () => {
  it('runs a full wake end-to-end with a backend, recording an episode and moving drives', async () => {
    const store = new FakeStore();
    store.charters.set('agent-1', makeCharter());

    const steps = createBackendWakeSteps({
      llm: fakeBackend(prompt => {
        if (prompt.includes('policy step')) {
          return JSON.stringify({ actionKind: 'read_paper', rationale: 'curiosity is high', expectedDriveDelta: {} });
        }
        // reflect: nudge curiosity up; groom never fires (charter is under budget)
        return JSON.stringify({
          reflection: 'Read the abstract.',
          summary: 'Skimmed the paper.',
          nextIntendedAction: 'Reproduce figure 1.',
          scopeLocks: ['did not run experiments'],
          drivesAfter: { ...NEUTRAL, curiosity: 0.7 },
        });
      }),
      modelId: 'fake-model',
    });

    let n = 0;
    const outcome = await runWakeCycle('agent-1', {
      store,
      steps,
      newEpisodeId: () => `ep-${++n}`,
      now: () => T0,
    });

    expect(store.episodes).toHaveLength(1);
    expect(outcome.episode.policyDecision.actionKind).toBe('read_paper');
    expect(outcome.episode.scopeLocks).toEqual(['did not run experiments']);
    expect(outcome.groomed).toBe(false);
    // Reflect proposed +0.2 on curiosity; within the per-wake clamp, so applied.
    expect(outcome.charter.drives.curiosity).toBeCloseTo(0.7, 5);
    expect(outcome.charter.version).toBe(5);
    expect(outcome.handoff.wakeCount).toBe(1);
    expect(outcome.handoff.nextIntendedAction).toBe('Reproduce figure 1.');
  });

  it('throws (no silent salvage) when the backend returns no JSON object', async () => {
    const store = new FakeStore();
    store.charters.set('agent-1', makeCharter());
    const steps = createBackendWakeSteps({
      llm: fakeBackend(() => 'I could not produce structured output.'),
      modelId: 'fake-model',
    });
    await expect(runWakeCycle('agent-1', { store, steps, newEpisodeId: () => 'ep-1', now: () => T0 })).rejects.toThrow(
      /no JSON object/
    );
  });
});
