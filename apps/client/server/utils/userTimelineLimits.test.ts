import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';

vi.mock('@bike4mind/database', () => ({ UserLimitEventModel: {} }));

import { limitDetail, limitRowToEntry, type LimitEventRow } from './userTimelineLimits';

const row = (overrides: Partial<LimitEventRow>): LimitEventRow => ({
  _id: new Types.ObjectId('6700000000000000000000aa'),
  kind: 'new_account_hourly_cap',
  modelId: '',
  count: 1,
  firstAt: new Date('2026-11-01T10:00:00Z'),
  lastAt: new Date('2026-11-01T10:40:00Z'),
  ...overrides,
});

describe('limitDetail', () => {
  it('spells out cap numbers', () => {
    expect(limitDetail(row({ details: { capCredits: 5000, spentCredits: 4980.6, requestedCredits: 120 } }))).toBe(
      'cap 5,000 · spent 4,981 · requested 120'
    );
  });

  it('names the model and the insufficient-credits reason', () => {
    expect(
      limitDetail(
        row({
          kind: 'insufficient_credits',
          modelId: 'opus',
          details: { reason: 'member_cap', requiredCredits: 40, availableCredits: 3 },
        })
      )
    ).toBe('opus · org member cap · needed 40 · had 3');
  });

  it('reports free-tier USD caps in dollars', () => {
    expect(limitDetail(row({ kind: 'free_tier_daily_cap', details: { capUsd: 0.5, spentUsd: 0.512 } }))).toBe(
      'cost cap $0.50 · cost $0.51'
    );
  });

  it('has no detail when there is nothing to say', () => {
    expect(limitDetail(row({ kind: 'model_requires_paid_plan' }))).toBeUndefined();
  });
});

describe('limitRowToEntry', () => {
  it('pages on the last hit, counts repeats in the summary, and always alerts', () => {
    const entry = limitRowToEntry(
      row({ kind: 'balance_debt', count: 3, details: { shortfall: 12, balanceAfter: -12 } })
    );
    expect(entry).toMatchObject({
      type: 'limit',
      id: '6700000000000000000000aa',
      at: new Date('2026-11-01T10:40:00Z'),
      summary: 'Balance went negative ×3',
      detail: 'shortfall 12 · balance after -12',
      alert: true,
    });
  });

  it('leaves the count off a single hit', () => {
    expect(limitRowToEntry(row({})).summary).toBe('Hit new-account hourly spend cap');
  });
});
