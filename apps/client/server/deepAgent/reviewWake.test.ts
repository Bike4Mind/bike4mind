import { describe, it, expect, vi } from 'vitest';
import type { Charter, DriveVector, Episode, ReviewVerdict } from '@bike4mind/agents';
import { runReviewWake, buildReviewPrompt, type ReviewStore } from './reviewWake';

const NEUTRAL: DriveVector = {
  curiosity: 0.5,
  progress: 0.5,
  social: 0.5,
  novelty: 0.5,
  caution: 0.5,
  aesthetic: 0.5,
};
const ISO = '2026-06-09T12:00:00.000Z';
const T0 = Date.parse(ISO);

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
    goal: { description: 'Reproduce the target paper', successCriteria: [], deadlineKind: 'none' },
    drives: { ...NEUTRAL },
    subgoals: [],
    semanticMemory: [],
    currentTier: 'engineering-proxy',
    openQuestions: [],
    blockers: [],
    sizeBudgetBytes: 8192,
    version: 3,
    updatedAt: ISO,
    ...overrides,
  };
}

function episode(id = 'ep-target'): Episode {
  return {
    id,
    agentId: 'agent-1',
    wakeAt: ISO,
    drivesBefore: NEUTRAL,
    policyDecision: { actionKind: 'run_experiment', rationale: 'x', expectedDriveDelta: {} },
    actionsTaken: [{ tool: 'code_execute', input: {}, succeeded: true }],
    observations: [{ kind: 'final_answer', summary: '2^61-1 is a Mersenne prime' }],
    reflection: 'verified primality computationally',
    charterDiff: { addedSemanticMemory: [], removedSemanticMemoryIds: [], subgoalStatusChanges: [], summary: 's' },
    drivesAfter: NEUTRAL,
    scopeLocks: ['did NOT use external validation'],
    evidenceTier: 'engineering-proxy',
    tokensSpent: 100,
    costUsd: 0,
  };
}

class FakeReviewStore implements ReviewStore {
  charters = new Map<string, Charter>();
  episodes = new Map<string, Episode>();
  appended: Episode[] = [];
  reviewedMarks: Array<{ episodeId: string; reviewerEpisodeId: string }> = [];

  async loadCharter(id: string) {
    return this.charters.get(id) ?? null;
  }
  async saveCharter(c: Charter) {
    this.charters.set(c.identity.agentId, c);
    return c;
  }
  async appendEpisode(e: Episode) {
    this.appended.push(e);
    return e;
  }
  async findEpisode(_agentId: string, episodeId: string) {
    return this.episodes.get(episodeId) ?? null;
  }
  async markEpisodeReviewed(_agentId: string, episodeId: string, reviewerEpisodeId: string) {
    this.reviewedMarks.push({ episodeId, reviewerEpisodeId });
  }
}

function deps(store: FakeReviewStore, verdict: ReviewVerdict, tokensSpent = 777) {
  let n = 0;
  return {
    store,
    reviewStep: vi.fn(async () => ({ verdict, tokensSpent, costUsd: 0 })),
    newEpisodeId: () => `rev-${++n}`,
    now: () => T0,
  };
}

describe('runReviewWake', () => {
  it('records the review as an episode and back-points the target', async () => {
    const store = new FakeReviewStore();
    store.charters.set('agent-1', charter());
    store.episodes.set('ep-target', episode());

    const outcome = await runReviewWake(
      'agent-1',
      'ep-target',
      deps(store, {
        verdict: 'needs-changes',
        issues: ['no external validation'],
        summary: 'computational check only',
      })
    );

    expect(outcome.reviewerEpisodeId).toBe('rev-1');
    expect(store.appended).toHaveLength(1);
    const rev = store.appended[0];
    expect(rev.policyDecision.actionKind).toBe('adversarial_review');
    expect(rev.observations[0].kind).toBe('review_verdict');
    expect(rev.observations[1]).toEqual({ kind: 'review_issue', summary: 'no external validation' });
    expect(store.reviewedMarks).toEqual([{ episodeId: 'ep-target', reviewerEpisodeId: 'rev-1' }]);
    expect(outcome.tierAdvanced).toBeUndefined();
  });

  it('advances the tier on approval with a higher tierGranted (one versioned write)', async () => {
    const store = new FakeReviewStore();
    store.charters.set('agent-1', charter({ version: 3, currentTier: 'engineering-proxy' }));
    store.episodes.set('ep-target', episode());

    const outcome = await runReviewWake(
      'agent-1',
      'ep-target',
      deps(store, {
        verdict: 'approved',
        issues: [],
        tierGranted: 'engineering-scaled',
        summary: 'holds up',
      })
    );

    expect(outcome.tierAdvanced).toEqual({ from: 'engineering-proxy', to: 'engineering-scaled' });
    const saved = store.charters.get('agent-1')!;
    expect(saved.currentTier).toBe('engineering-scaled');
    expect(saved.version).toBe(4); // exactly one bump
  });

  it('does NOT advance tier on approval at-or-below the current tier', async () => {
    const store = new FakeReviewStore();
    store.charters.set('agent-1', charter({ currentTier: 'engineering-scaled', version: 5 }));
    store.episodes.set('ep-target', episode());

    const outcome = await runReviewWake(
      'agent-1',
      'ep-target',
      deps(store, {
        verdict: 'approved',
        issues: [],
        tierGranted: 'engineering-proxy', // below current — no movement
        summary: 'fine at proxy',
      })
    );

    expect(outcome.tierAdvanced).toBeUndefined();
    expect(store.charters.get('agent-1')!.version).toBe(5); // untouched
  });

  it('does NOT advance tier when rejected, even with a tierGranted', async () => {
    const store = new FakeReviewStore();
    store.charters.set('agent-1', charter());
    store.episodes.set('ep-target', episode());

    const outcome = await runReviewWake(
      'agent-1',
      'ep-target',
      deps(store, {
        verdict: 'rejected',
        issues: ['claims refuted'],
        tierGranted: 'external-facing',
        summary: 'does not hold',
      })
    );

    expect(outcome.tierAdvanced).toBeUndefined();
    expect(store.charters.get('agent-1')!.currentTier).toBe('engineering-proxy');
  });

  it('throws on a missing target episode', async () => {
    const store = new FakeReviewStore();
    store.charters.set('agent-1', charter());
    await expect(
      runReviewWake('agent-1', 'ghost-ep', deps(store, { verdict: 'approved', issues: [], summary: 's' }))
    ).rejects.toThrow(/no episode/);
  });

  it('refuses an already-reviewed target BEFORE spending an LLM call (write-once)', async () => {
    const store = new FakeReviewStore();
    store.charters.set('agent-1', charter());
    store.episodes.set('ep-target', { ...episode(), reviewedByEpisodeId: 'rev-earlier' });

    const d = deps(store, { verdict: 'approved', issues: [], summary: 's' });
    await expect(runReviewWake('agent-1', 'ep-target', d)).rejects.toThrow(/already reviewed by rev-earlier/);
    expect(d.reviewStep).not.toHaveBeenCalled(); // no token burn
    expect(store.appended).toHaveLength(0);
  });

  it('records the reviewer LLM spend on the reviewer episode (honest accounting)', async () => {
    const store = new FakeReviewStore();
    store.charters.set('agent-1', charter());
    store.episodes.set('ep-target', episode());

    await runReviewWake(
      'agent-1',
      'ep-target',
      deps(store, { verdict: 'needs-changes', issues: [], summary: 's' }, 4321)
    );
    expect(store.appended[0].tokensSpent).toBe(4321);
  });
});

describe('buildReviewPrompt', () => {
  it('carries the refuting stance, the episode claims, and the scope locks', () => {
    const text = buildReviewPrompt(charter(), episode());
    expect(text).toContain('ADVERSARIAL REVIEWER');
    expect(text).toContain('REFUTE');
    expect(text).toContain('2^61-1 is a Mersenne prime');
    expect(text).toContain('did NOT use external validation');
    expect(text).toContain('tierGranted');
  });

  it('surfaces memory ids no longer in the charter instead of silently omitting them', () => {
    const ep = episode();
    ep.charterDiff.addedSemanticMemory = ['m-groomed-away'];
    const text = buildReviewPrompt(charter({ semanticMemory: [] }), ep);
    expect(text).toContain('m-groomed-away no longer in charter memory');
  });
});
