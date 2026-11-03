import { describe, expect, it } from 'vitest';
import { type ClaimCandidate, planFreeCreditClaims } from './20260921235965_backfill-free-credit-claim-email';

const candidate = (
  userId: string,
  email: string | null,
  grantedDay: number | null,
  existingClaim: string | null = null
): ClaimCandidate => ({
  userId,
  email,
  existingClaim,
  grantedAt: grantedDay === null ? null : new Date(Date.UTC(2026, 0, grantedDay)),
});

describe('planFreeCreditClaims', () => {
  it('gives each inbox to its earliest-granted account and reports the aliases', () => {
    const plan = planFreeCreditClaims([
      candidate('late', 'x+2@gmail.com', 3),
      candidate('first', 'x.y@gmail.com', 1),
      candidate('mid', 'xy+1@googlemail.com', 2),
      candidate('solo', 'someone@example.com', 1),
    ]);

    expect(plan.set).toEqual([
      { userId: 'first', claimEmail: 'xy@gmail.com' },
      { userId: 'solo', claimEmail: 'someone@example.com' },
      { userId: 'late', claimEmail: 'x@gmail.com' },
    ]);
    expect(plan.unset).toEqual([]);
    expect(plan.clusters).toEqual([{ claimEmail: 'xy@gmail.com', holderId: 'first', otherIds: ['mid'] }]);
  });

  it('keeps an existing runtime claim over an older unclaimed grant', () => {
    const plan = planFreeCreditClaims([
      candidate('old', 'a.b@gmail.com', 1),
      candidate('runtime', 'ab+new@gmail.com', 5, 'ab@gmail.com'),
    ]);

    expect(plan.set).toEqual([]);
    expect(plan.clusters).toEqual([{ claimEmail: 'ab@gmail.com', holderId: 'runtime', otherIds: ['old'] }]);
  });

  it('clears all but the earliest of duplicate runtime claims', () => {
    const plan = planFreeCreditClaims([
      candidate('second', 'ab+2@gmail.com', 2, 'ab@gmail.com'),
      candidate('first', 'ab+1@gmail.com', 1, 'ab@gmail.com'),
    ]);

    expect(plan.unset).toEqual(['second']);
    expect(plan.clusters).toEqual([{ claimEmail: 'ab@gmail.com', holderId: 'first', otherIds: ['second'] }]);
  });

  it('skips accounts with no usable email', () => {
    expect(planFreeCreditClaims([candidate('no-email', null, 1), candidate('bad', 'not-an-email', 1)])).toEqual({
      set: [],
      unset: [],
      clusters: [],
    });
  });
});
