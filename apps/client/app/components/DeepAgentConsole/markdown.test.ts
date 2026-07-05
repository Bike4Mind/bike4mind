import { describe, it, expect } from 'vitest';
import type { Charter, DriveVector, Episode, Handoff } from '@bike4mind/agents';
import { formatAgentDossierMarkdown } from './markdown';

const NEUTRAL: DriveVector = {
  curiosity: 0.65,
  progress: 0.5,
  social: 0.5,
  novelty: 0.5,
  caution: 0.83,
  aesthetic: 0.5,
};
const ISO = '2026-06-10T18:39:47.000Z';

const charter: Charter = {
  identity: {
    agentId: 'agent-icarus',
    ownerUserId: 'owner-1',
    name: 'Icarus',
    role: 'default',
    instantiatedAt: ISO,
    schemaVersion: 1,
  },
  goal: { description: 'Verify 2^127 - 1 is prime.', successCriteria: [], deadlineKind: 'none' },
  drives: NEUTRAL,
  subgoals: [],
  semanticMemory: [
    {
      id: 'm1',
      fact: '2^127 - 1 is a prime number',
      evidenceTier: 'engineering-proxy',
      confidence: 1,
      sourceEpisodeIds: ['31633d32-aaaa'],
      lastAffirmedAt: ISO,
    },
  ],
  currentTier: 'engineering-proxy',
  openQuestions: [],
  blockers: ['confidence coefficient must be corrected'],
  sizeBudgetBytes: 8192,
  version: 2,
  updatedAt: ISO,
};

const handoff: Handoff = {
  agentId: 'agent-icarus',
  wakeCount: 2,
  lastWakeAt: ISO,
  lastActionSummary: 'verified primality',
  nextIntendedAction: 'apply the memory correction',
  openBlockers: [],
  updatedAt: ISO,
};

const reviewEpisode: Episode = {
  id: 'rev-1',
  agentId: 'agent-icarus',
  wakeAt: ISO,
  drivesBefore: NEUTRAL,
  policyDecision: {
    actionKind: 'adversarial_review',
    rationale: 'Independent review of episode 31633d32',
    expectedDriveDelta: {},
  },
  actionsTaken: [],
  observations: [
    {
      kind: 'review_verdict',
      summary: 'needs-changes (tier granted: engineering-proxy): confidence overstated',
      artifactRef: '31633d32-aaaa',
    },
    { kind: 'review_issue', summary: 'confidence coefficient is dishonest' },
  ],
  reflection: 'needs-changes (tier granted: engineering-proxy): confidence overstated',
  charterDiff: { addedSemanticMemory: [], removedSemanticMemoryIds: [], subgoalStatusChanges: [], summary: 'review' },
  drivesAfter: NEUTRAL,
  scopeLocks: ['review-only: did NOT modify memory, goals, or drives'],
  evidenceTier: 'engineering-proxy',
  tokensSpent: 2158,
  costUsd: 0,
};

const workEpisode: Episode = {
  id: '31633d32-aaaa',
  agentId: 'agent-icarus',
  wakeAt: ISO,
  drivesBefore: NEUTRAL,
  policyDecision: { actionKind: 'code_execute', rationale: 'Direct path to verification', expectedDriveDelta: {} },
  actionsTaken: [{ tool: 'code_execute', input: {}, succeeded: true }],
  observations: [{ kind: 'final_answer', summary: 'PRIME via Miller-Rabin (40 rounds)' }],
  reflection: 'verified with high confidence',
  charterDiff: {
    addedSemanticMemory: ['m1'],
    removedSemanticMemoryIds: [],
    subgoalStatusChanges: [],
    summary: 'added m1',
  },
  drivesAfter: NEUTRAL,
  scopeLocks: ['Did NOT verify the implementation itself'],
  evidenceTier: 'engineering-proxy',
  tokensSpent: 7059,
  costUsd: 0,
  reviewedByEpisodeId: 'rev-1',
};

describe('formatAgentDossierMarkdown', () => {
  it('renders the full dossier — identity, drives, memory provenance, blockers, episodes, verdicts, locks', () => {
    const md = formatAgentDossierMarkdown({ charter, handoff, episodes: [reviewEpisode, workEpisode] });

    expect(md).toContain('# Icarus — Deep Agent Dossier');
    expect(md).toContain('**Role:** default · **Tier:** engineering-proxy · **v2** · 2 wakes');
    expect(md).toContain('**Next intended action:** apply the memory correction');
    expect(md).toContain('curiosity 0.65');
    expect(md).toContain('caution 0.83');
    expect(md).toContain('- 2^127 - 1 is a prime number');
    expect(md).toContain('conf 1.00 · from episode `31633d32…`');
    expect(md).toContain('🚧 confidence coefficient must be corrected');
    expect(md).toContain('`adversarial_review`');
    expect(md).toContain('**⚖️ Verdict:** needs-changes');
    expect(md).toContain('⚠️ confidence coefficient is dishonest');
    expect(md).toContain('reviewed ✓ (by `rev-1');
    expect(md).toContain('🔒 Did NOT verify the implementation itself');
    expect(md).toContain('PRIME via Miller-Rabin (40 rounds)');
    expect(md).toContain('agent `agent-icarus`');
  });

  it('handles a freshly enrolled agent (no handoff, no memory, no episodes)', () => {
    const md = formatAgentDossierMarkdown({
      charter: { ...charter, semanticMemory: [], blockers: [] },
      handoff: null,
      episodes: [],
    });
    expect(md).toContain('no wakes yet');
    expect(md).toContain('nothing groomed into long-term memory yet');
    expect(md).not.toContain('## Blockers');
  });
});
