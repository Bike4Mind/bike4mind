import { describe, expect, it } from 'vitest';
import {
  ADMIN_GRANT_HARD_LIMIT,
  ADMIN_GRANT_IMMEDIATE_LIMIT,
  ADMIN_GRANT_LIMIT_ERROR_CODE,
  creditsToUsd,
  adminGrantRoom,
  isGrantLimitRefusal,
} from './adminCreditGrants';

describe('creditsToUsd', () => {
  it.each([
    [2_500, '$1.50'],
    [100_000, '$60'],
    [250_000, '$150'],
    [500_000, '$300'],
    [5_000_000, '$3,000'],
    [0, '$0'],
    [1, 'less than $0.01'],
    [8, 'less than $0.01'],
    [9, '$0.01'],
    [17, '$0.01'],
    [1_234_567, '$740.74'],
  ])('shows %i credits as %s', (credits, shown) => {
    expect(creditsToUsd(credits)).toBe(shown);
  });

  it('prices the grant limits at their documented dollar values', () => {
    expect(creditsToUsd(ADMIN_GRANT_IMMEDIATE_LIMIT)).toBe('$60');
    expect(creditsToUsd(ADMIN_GRANT_HARD_LIMIT)).toBe('$300');
  });
});

describe('isGrantLimitRefusal', () => {
  const refusal = { code: ADMIN_GRANT_LIMIT_ERROR_CODE, error: 'over the limit', reason: 'confirmation_required' };

  it('is true for any grant-cap refusal and nothing else', () => {
    expect(isGrantLimitRefusal(refusal)).toBe(true);
    expect(isGrantLimitRefusal({ ...refusal, reason: 'hard_limit' })).toBe(true);
    expect(isGrantLimitRefusal({ ...refusal, code: 'forbidden' })).toBe(false);
    expect(isGrantLimitRefusal(undefined)).toBe(false);
    expect(isGrantLimitRefusal('admin_grant_limit')).toBe(false);
  });
});

describe('adminGrantRoom', () => {
  it('gives a standard admin the room under 100k for both the immediate and the unconfirmed grant', () => {
    expect(adminGrantRoom({ receivedCredits: 30_000, immediateLimit: ADMIN_GRANT_IMMEDIATE_LIMIT })).toEqual({
      immediate: 70_000,
      unconfirmed: 70_000,
      hard: 470_000,
    });
  });

  it('gives an approver the room under 500k at once but still asks for the phrase past 100k', () => {
    expect(adminGrantRoom({ receivedCredits: 30_000, immediateLimit: ADMIN_GRANT_HARD_LIMIT })).toEqual({
      immediate: 470_000,
      unconfirmed: 70_000,
      hard: 470_000,
    });
  });

  it('never goes negative once the recipient is past a limit', () => {
    expect(adminGrantRoom({ receivedCredits: 600_000, immediateLimit: ADMIN_GRANT_IMMEDIATE_LIMIT })).toEqual({
      immediate: 0,
      unconfirmed: 0,
      hard: 0,
    });
  });
});
