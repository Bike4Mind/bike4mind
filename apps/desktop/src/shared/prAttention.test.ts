import { describe, expect, it } from 'vitest';
import {
  PR_ATTENTIONS,
  isPrAttention,
  prAttentionOf,
  prAttentionRank,
  prIconStatus,
  type PrAttention,
  type PrAttentionInput,
} from './prAttention';
import type { PrCheck } from './pullRequest';

const pass: PrCheck = { name: 'build', bucket: 'pass', required: true };
const fail: PrCheck = { name: 'lint', bucket: 'fail', required: false };
const pending: PrCheck = { name: 'test', bucket: 'pending', required: true };

/** An approved, green, mergeable PR: `ready` until an override says otherwise. */
function pr(overrides: Partial<PrAttentionInput> = {}): PrAttentionInput {
  return {
    state: 'OPEN',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: 'APPROVED',
    checks: [pass],
    ...overrides,
  };
}

describe('prAttentionOf', () => {
  it.each<[string, Partial<PrAttentionInput>, PrAttention]>([
    ['conflict (CONFLICTING)', { mergeable: 'CONFLICTING' }, 'conflict'],
    ['conflict (DIRTY)', { mergeStateStatus: 'DIRTY' }, 'conflict'],
    ['ciFailed, any failing check required or not', { checks: [pass, fail], mergeStateStatus: 'UNSTABLE' }, 'ciFailed'],
    ['changesRequested', { reviewDecision: 'CHANGES_REQUESTED' }, 'changesRequested'],
    ['ciRunning', { checks: [pass, pending] }, 'ciRunning'],
    ['awaitingReview', { reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }, 'awaitingReview'],
    ['approvedBlocked', { mergeStateStatus: 'BLOCKED' }, 'approvedBlocked'],
    ['blocked with no review required', { reviewDecision: null, mergeStateStatus: 'BLOCKED' }, 'approvedBlocked'],
    ['ready', {}, 'ready'],
    ['ready with no review required and no checks', { reviewDecision: null, checks: [] }, 'ready'],
    ['ready when behind (shown as a badge)', { mergeStateStatus: 'BEHIND' }, 'ready'],
    ['ready with hooks', { mergeStateStatus: 'HAS_HOOKS' }, 'ready'],
  ])('%s', (_name, overrides, expected) => {
    expect(prAttentionOf(pr(overrides))).toBe(expected);
  });

  it('says nothing while GitHub is still computing mergeability', () => {
    expect(prAttentionOf(pr({ mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN' }))).toBeNull();
  });

  it('is null for drafts and finished PRs', () => {
    expect(prAttentionOf(pr({ isDraft: true }))).toBeNull();
    expect(prAttentionOf(pr({ state: 'MERGED' }))).toBeNull();
    expect(prAttentionOf(pr({ state: 'CLOSED' }))).toBeNull();
  });

  it('ranks conflict > ciFailed > changesRequested > ciRunning > awaitingReview when several apply', () => {
    const everything = pr({
      mergeable: 'CONFLICTING',
      checks: [fail, pending],
      reviewDecision: 'CHANGES_REQUESTED',
    });
    expect(prAttentionOf(everything)).toBe('conflict');
    expect(prAttentionOf({ ...everything, mergeable: 'MERGEABLE' })).toBe('ciFailed');
    expect(prAttentionOf({ ...everything, mergeable: 'MERGEABLE', checks: [pending] })).toBe('changesRequested');
    expect(prAttentionOf(pr({ checks: [pending], reviewDecision: 'REVIEW_REQUIRED' }))).toBe('ciRunning');
    expect(prAttentionOf(pr({ reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' }))).toBe(
      'awaitingReview'
    );
  });
});

describe('prIconStatus', () => {
  const full = { ...pr(), autoMergeArmed: false };

  it('adds behind and auto-merge only when they hold, and only for an open PR', () => {
    expect(prIconStatus(full, { queued: false, appAutoMerge: false })).toEqual({ state: 'open', attention: 'ready' });
    expect(
      prIconStatus(
        { ...full, mergeStateStatus: 'BEHIND', autoMergeArmed: true },
        { queued: false, appAutoMerge: false }
      )
    ).toEqual({ state: 'open', attention: 'ready', behind: true, autoMerge: true });
    expect(prIconStatus(full, { queued: false, appAutoMerge: true }).autoMerge).toBe(true);
    expect(
      prIconStatus({ ...full, isDraft: true, autoMergeArmed: true }, { queued: false, appAutoMerge: false })
    ).toEqual({ state: 'draft' });
    expect(prIconStatus(full, { queued: true, appAutoMerge: false })).toEqual({ state: 'queued' });
  });
});

describe('prAttentionRank', () => {
  it('orders open PRs by attention, then other live PRs, then none or finished', () => {
    const ranks = PR_ATTENTIONS.map(attention => prAttentionRank({ state: 'open', attention }));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    expect(prAttentionRank({ state: 'draft' })).toBeGreaterThan(prAttentionRank({ state: 'open', attention: 'ready' }));
    expect(prAttentionRank(undefined)).toBeGreaterThan(prAttentionRank({ state: 'draft' }));
    expect(prAttentionRank({ state: 'merged' })).toBe(prAttentionRank(undefined));
  });

  it('guards stored values', () => {
    expect(isPrAttention('ciFailed')).toBe(true);
    expect(isPrAttention('green')).toBe(false);
    expect(isPrAttention(3)).toBe(false);
  });
});
