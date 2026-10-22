import { describe, it, expect } from 'vitest';
import type { Charter, DriveVector, Handoff } from '@bike4mind/agents';
import { buildGroomPrompt, buildOrientPrompt, buildReflectPrompt } from './prompts';

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
    subgoals: [
      {
        id: 's1',
        description: 'read the paper',
        status: 'active',
        priority: 70,
        targetTier: 'engineering-scaled',
        dependsOn: [],
      },
    ],
    semanticMemory: [
      {
        id: 'm1',
        fact: 'KCuF3 is a 1D antiferromagnet',
        evidenceTier: 'external-facing',
        confidence: 0.8,
        sourceEpisodeIds: [],
        lastAffirmedAt: ISO,
      },
    ],
    currentTier: 'engineering-proxy',
    openQuestions: ['which solver?'],
    blockers: [],
    sizeBudgetBytes: 8192,
    version: 1,
    updatedAt: ISO,
    ...overrides,
  };
}

// The tuned cognitive prompts (orient/reflect/groom) are the host-private tier;
// the open framework's render helpers + act prompt are tested in @bike4mind/agents.
describe('tuned step prompts', () => {
  it('orient prompt carries the policy-step marker and drive summary', () => {
    const text = buildOrientPrompt({ charter: charter(), handoff: null, recentEpisodes: [], drives: NEUTRAL });
    expect(text).toContain('policy step');
    expect(text).toContain('Current drives:');
    expect(text).toContain('first wake');
  });

  it('reflect prompt carries the reflect-step marker and asks for scopeLocks', () => {
    const text = buildReflectPrompt({
      charter: charter(),
      policy: { actionKind: 'read_paper', rationale: 'x', expectedDriveDelta: {} },
      act: { actionsTaken: [], observations: [], tokensSpent: 0, costUsd: 0 },
      drives: NEUTRAL,
    });
    expect(text).toContain('reflect step');
    expect(text).toContain('scopeLocks');
  });

  it('groom prompt carries the groom-step marker and the measured size', () => {
    const text = buildGroomPrompt({ charter: charter({ sizeBudgetBytes: 50 }), recentEpisodes: [] });
    expect(text).toContain('groom step');
    expect(text).toMatch(/\d+ bytes used vs 50 budget/);
  });

  it('orient renders the prior handoff when present', () => {
    const handoff: Handoff = {
      agentId: 'agent-1',
      wakeCount: 3,
      lastWakeAt: ISO,
      lastActionSummary: 'ran the proxy probe',
      nextIntendedAction: 'scale up',
      openBlockers: [],
      updatedAt: ISO,
    };
    const text = buildOrientPrompt({ charter: charter(), handoff, recentEpisodes: [], drives: NEUTRAL });
    expect(text).toContain('Last wake (#3): ran the proxy probe');
    expect(text).toContain('Intended next action: scale up');
  });
});
