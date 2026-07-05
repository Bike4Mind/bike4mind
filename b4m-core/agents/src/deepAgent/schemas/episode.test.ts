import { describe, it, expect } from 'vitest';
import { ActionTakenSchema, EpisodeSchema, PolicyDecisionSchema, type Episode } from './episode';
import { DEFAULT_DRIVES } from './drives';

const ISO = '2026-06-08T00:00:00.000Z';

/** Minimal input satisfying every required Episode field. */
function minimalEpisodeInput() {
  return {
    id: 'ep-1',
    agentId: 'agent-1',
    wakeAt: ISO,
    drivesBefore: DEFAULT_DRIVES,
    policyDecision: { actionKind: 'read_paper', rationale: 'curiosity is high' },
    reflection: 'Read the abstract; identified two reproducible claims.',
    charterDiff: { summary: 'no charter change this wake' },
    drivesAfter: DEFAULT_DRIVES,
    evidenceTier: 'engineering-proxy',
  };
}

describe('EpisodeSchema defaults', () => {
  it('defaults the collection + accounting fields', () => {
    const episode = EpisodeSchema.parse(minimalEpisodeInput());
    expect(episode.actionsTaken).toEqual([]);
    expect(episode.observations).toEqual([]);
    expect(episode.scopeLocks).toEqual([]);
    expect(episode.tokensSpent).toBe(0);
    expect(episode.costUsd).toBe(0);
    expect(episode.reviewedByEpisodeId).toBeUndefined();
  });
});

describe('EpisodeSchema scope locks — the q-paper invariant', () => {
  it('preserves an explicit enumeration of what was NOT done', () => {
    const episode = EpisodeSchema.parse({
      ...minimalEpisodeInput(),
      scopeLocks: [
        'did NOT generate exact Lee 2026 target states',
        'did NOT touch billing',
        'did NOT change evidence labels',
      ],
    });
    expect(episode.scopeLocks).toHaveLength(3);
    expect(episode.scopeLocks).toContain('did NOT touch billing');
  });
});

describe('EpisodeSchema validation', () => {
  it('requires an evidence tier (no silent default)', () => {
    const bad = minimalEpisodeInput() as Record<string, unknown>;
    delete bad.evidenceTier;
    expect(EpisodeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown evidence tier', () => {
    expect(EpisodeSchema.safeParse({ ...minimalEpisodeInput(), evidenceTier: 'made-up' }).success).toBe(false);
  });

  it('requires a non-empty reflection', () => {
    expect(EpisodeSchema.safeParse({ ...minimalEpisodeInput(), reflection: '' }).success).toBe(false);
  });

  it('requires both drive vectors', () => {
    const bad = minimalEpisodeInput() as Record<string, unknown>;
    delete bad.drivesAfter;
    expect(EpisodeSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts an optional reviewer back-pointer', () => {
    const episode: Episode = EpisodeSchema.parse({
      ...minimalEpisodeInput(),
      reviewedByEpisodeId: 'ep-reviewer-7',
    });
    expect(episode.reviewedByEpisodeId).toBe('ep-reviewer-7');
  });
});

describe('PolicyDecisionSchema', () => {
  it('defaults expectedDriveDelta to an empty record', () => {
    const decision = PolicyDecisionSchema.parse({ actionKind: 'ideate', rationale: 'novelty low' });
    expect(decision.expectedDriveDelta).toEqual({});
  });

  it('requires a non-empty actionKind and rationale', () => {
    expect(PolicyDecisionSchema.safeParse({ actionKind: '', rationale: 'x' }).success).toBe(false);
    expect(PolicyDecisionSchema.safeParse({ actionKind: 'x', rationale: '' }).success).toBe(false);
  });
});

describe('ActionTakenSchema', () => {
  it('accepts an arbitrary structured input payload', () => {
    const action = ActionTakenSchema.parse({
      tool: 'run_experiment',
      input: { graphSize: 32, seed: 7 },
      succeeded: true,
      durationMs: 1200,
    });
    expect(action.succeeded).toBe(true);
    expect(action.durationMs).toBe(1200);
  });

  it('rejects a negative duration', () => {
    expect(ActionTakenSchema.safeParse({ tool: 't', input: null, succeeded: true, durationMs: -1 }).success).toBe(
      false
    );
  });
});
