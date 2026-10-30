import { describe, expect, it } from 'vitest';
import type { UserCreditHistory } from '@bike4mind/common';
import { creditSpendFromHistory } from './creditSpend';

const history = (overrides: Partial<UserCreditHistory> = {}): UserCreditHistory => ({
  windowDays: 90,
  currentBalance: 0,
  points: [],
  adjustments: [],
  adjustmentsTruncated: false,
  unreliableBefore: null,
  ...overrides,
});

const points = (...balances: number[]) =>
  balances.map((balance, index) => ({ day: `2026-10-${String(index + 1).padStart(2, '0')}`, balance }));

describe('creditSpendFromHistory', () => {
  it('counts every drop as spend and ignores rises', () => {
    const spend = creditSpendFromHistory(history({ points: points(100, 80, 200, 150) }));
    expect(spend.daily).toEqual([20, 0, 50]);
    expect(spend.total).toBe(70);
    expect(spend.estimated).toBe(false);
  });

  it('does not count an admin deduction as usage', () => {
    const spend = creditSpendFromHistory(
      history({
        points: points(100, 40),
        adjustments: [{ transactionId: 't', occurredAt: '2026-10-02T10:00:00Z', credits: -50, actorName: 'Admin' }],
      })
    );
    expect(spend.daily).toEqual([10]);
  });

  it('keeps only the last window of days', () => {
    expect(creditSpendFromHistory(history({ points: points(100, 90, 80, 70) }), 2).daily).toEqual([10, 10]);
  });

  it('flags the result as an estimate when the window starts before the reliable point', () => {
    expect(
      creditSpendFromHistory(history({ points: points(10, 5), unreliableBefore: '2026-10-02T00:00:00Z' })).estimated
    ).toBe(true);
  });

  it('is zero for an empty history', () => {
    expect(creditSpendFromHistory(history())).toEqual({ total: 0, daily: [], estimated: false });
  });
});
