import { describe, it, expect } from 'vitest';
import type { Charter, DriveVector, Episode } from '../schemas';
import { buildActSystemPrompt, renderCharter, renderRecentEpisodes } from './prompts';

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

describe('renderCharter', () => {
  it('includes identity, goal, tier, subgoals, and memory', () => {
    const text = renderCharter(charter());
    expect(text).toContain('Reproducer (paper-repro)');
    expect(text).toContain('Operating tier: engineering-proxy');
    expect(text).toContain('Reproduce the target paper');
    expect(text).toContain('read the paper');
    expect(text).toContain('KCuF3 is a 1D antiferromagnet');
    expect(text).toContain('which solver?');
  });

  it('renders empty sections gracefully', () => {
    const text = renderCharter(charter({ subgoals: [], semanticMemory: [], openQuestions: [], blockers: [] }));
    expect(text).toContain('Subgoals:\n  (none)');
    expect(text).toContain('Open questions: (none)');
  });
});

describe('renderRecentEpisodes', () => {
  it('notes the early-wake case with no episodes', () => {
    expect(renderRecentEpisodes([])).toMatch(/no prior episodes/i);
  });

  it('renders scope locks per episode', () => {
    const ep: Episode = {
      id: 'ep-1',
      agentId: 'agent-1',
      wakeAt: ISO,
      drivesBefore: NEUTRAL,
      policyDecision: { actionKind: 'read_paper', rationale: 'x', expectedDriveDelta: {} },
      actionsTaken: [],
      observations: [],
      reflection: 'read abstract',
      charterDiff: { addedSemanticMemory: [], removedSemanticMemoryIds: [], subgoalStatusChanges: [], summary: 's' },
      drivesAfter: NEUTRAL,
      scopeLocks: ['did NOT run experiments'],
      evidenceTier: 'engineering-proxy',
      tokensSpent: 0,
      costUsd: 0,
    };
    const text = renderRecentEpisodes([ep]);
    expect(text).toContain('[read_paper]');
    expect(text).toContain('scope-locks: did NOT run experiments');
  });
});

describe('buildActSystemPrompt', () => {
  it('leads with the linked agent persona when provided, else with the agent identity', () => {
    const ctx = {
      charter: charter(),
      policy: { actionKind: 'x', rationale: 'y', expectedDriveDelta: {} },
      drives: NEUTRAL,
    };
    const persona = 'You are Atlas, a go-to-market strategist.';
    const withPersona = buildActSystemPrompt(ctx, persona);
    expect(withPersona.startsWith(persona)).toBe(true);
    expect(withPersona).toContain('Your goal:');
    // and stays unchanged without one
    expect(buildActSystemPrompt(ctx).startsWith('You are Reproducer')).toBe(true);
  });
});
