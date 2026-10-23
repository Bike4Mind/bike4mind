import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@bike4mind/observability';
import type { Charter, DriveVector, Episode, Handoff, WakeOutcome } from '@bike4mind/agents';
import {
  bridgeWakeToSession,
  bridgeReviewToSession,
  formatWakeLogEntry,
  formatReviewLogEntry,
  type MissionBridgeDeps,
} from './missionSessionBridge';

const NEUTRAL: DriveVector = {
  curiosity: 0.5,
  progress: 0.5,
  social: 0.5,
  novelty: 0.5,
  caution: 0.5,
  aesthetic: 0.5,
};
const ISO = '2026-06-12T12:00:00.000Z';

function charter(overrides: Partial<Charter['identity']> = {}): Charter {
  return {
    identity: {
      agentId: 'mission-1',
      ownerUserId: 'erik',
      linkedAgentId: 'b4m-coffee',
      name: 'Coffee',
      role: 'default',
      instantiatedAt: ISO,
      schemaVersion: 1,
      ...overrides,
    },
    goal: { description: 'Draft marketing copy each wake.', successCriteria: [], deadlineKind: 'none' },
    drives: NEUTRAL,
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

function outcome(c = charter()): WakeOutcome {
  const episode: Episode = {
    id: 'ep-1',
    agentId: c.identity.agentId,
    wakeAt: ISO,
    drivesBefore: NEUTRAL,
    policyDecision: { actionKind: 'draft_copy', rationale: 'r', expectedDriveDelta: {} },
    actionsTaken: [],
    observations: [{ kind: 'final_answer', summary: 'Here is the draft: "Own your AI."' }],
    reflection: 'drafted a sovereignty-angle tagline',
    charterDiff: { addedSemanticMemory: [], removedSemanticMemoryIds: [], subgoalStatusChanges: [], summary: 's' },
    drivesAfter: NEUTRAL,
    scopeLocks: [],
    evidenceTier: 'engineering-proxy',
    tokensSpent: 1234,
    costUsd: 0,
  };
  const handoff: Handoff = {
    agentId: c.identity.agentId,
    wakeCount: 2,
    lastWakeAt: ISO,
    lastActionSummary: 'Drafted one tagline with the sovereignty angle.',
    nextIntendedAction: 'Try the builder-craft angle.',
    openBlockers: [],
    updatedAt: ISO,
  };
  return { episode, charter: c, handoff, groomed: false };
}

function fakeDeps() {
  const entries: Array<{ sessionId: string; prompt: string; reply: string }> = [];
  const deps: MissionBridgeDeps = {
    ensureSession: vi.fn(async () => 'session-42'),
    appendEntry: vi.fn(async (sessionId, prompt, reply) => {
      entries.push({ sessionId, prompt, reply });
    }),
  };
  return { deps, entries };
}

describe('formatWakeLogEntry', () => {
  it('composes wake header, summary, deliverable, and next action', () => {
    const { prompt, reply } = formatWakeLogEntry(outcome());
    expect(prompt).toBe('[WAKE 2] Coffee: draft_copy');
    expect(reply).toContain('**Wake 2** — `draft_copy` (engineering-proxy · 1,234 tok)');
    expect(reply).toContain('Drafted one tagline with the sovereignty angle.');
    expect(reply).toContain('Here is the draft: "Own your AI."');
    expect(reply).toContain('_Next: Try the builder-craft angle._');
  });
});

describe('bridgeWakeToSession', () => {
  it('ensures the session and appends the wake entry for a linked mission', async () => {
    const { deps, entries } = fakeDeps();
    await bridgeWakeToSession(outcome(), new Logger(), deps);
    expect(deps.ensureSession).toHaveBeenCalledOnce();
    expect(entries).toHaveLength(1);
    expect(entries[0].sessionId).toBe('session-42');
  });

  it('skips standalone deep agents (no linkedAgentId) — no session spam', async () => {
    const { deps, entries } = fakeDeps();
    await bridgeWakeToSession(outcome(charter({ linkedAgentId: undefined })), new Logger(), deps);
    expect(deps.ensureSession).not.toHaveBeenCalled();
    expect(entries).toHaveLength(0);
  });

  it('never throws — bridge failures are non-fatal to the wake', async () => {
    const deps: MissionBridgeDeps = {
      ensureSession: vi.fn(async () => {
        throw new Error('mongo down');
      }),
      appendEntry: vi.fn(),
    };
    await expect(bridgeWakeToSession(outcome(), new Logger(), deps)).resolves.toBeUndefined();
  });
});

describe('formatReviewLogEntry + bridgeReviewToSession', () => {
  const review = {
    verdict: {
      verdict: 'needs-changes' as const,
      issues: ['confidence overstated'],
      summary: 'probabilistic test ≠ verified fact',
    },
    reviewerEpisodeId: 'rev-1',
  };

  it('composes the verdict entry with issues', () => {
    const { prompt, reply } = formatReviewLogEntry(charter(), review, { id: 'ep-target-12345678' });
    expect(prompt).toBe('[REVIEW] Coffee: needs-changes');
    expect(reply).toContain('**needs-changes**');
    expect(reply).toContain('⚠️ confidence overstated');
    expect(reply).toContain('ep-targe');
  });

  it('notes tier advancement when the gate moved', () => {
    const { reply } = formatReviewLogEntry(
      charter(),
      {
        verdict: { verdict: 'approved', issues: [], tierGranted: 'engineering-scaled', summary: 'holds up' },
        reviewerEpisodeId: 'rev-2',
        tierAdvanced: { from: 'engineering-proxy', to: 'engineering-scaled' },
      },
      { id: 'ep-x' }
    );
    expect(reply).toContain('tier advanced engineering-proxy → engineering-scaled');
  });

  it('bridges only linked missions', async () => {
    const { deps, entries } = fakeDeps();
    await bridgeReviewToSession(charter({ linkedAgentId: undefined }), review, 'ep-x', new Logger(), deps);
    expect(entries).toHaveLength(0);
    await bridgeReviewToSession(charter(), review, 'ep-x', new Logger(), deps);
    expect(entries).toHaveLength(1);
  });
});
