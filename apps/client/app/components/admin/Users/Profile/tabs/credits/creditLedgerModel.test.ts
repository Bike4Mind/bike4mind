import { describe, expect, it } from 'vitest';
import { ADMIN_LEDGER_KINDS, type AdminLedgerRow } from '@bike4mind/common';
import {
  EMPTY_LEDGER_FILTER,
  LEDGER_FILTER_OPTIONS,
  SPEND_BREAKDOWN_MAX_BARS,
  formatSpendDay,
  hasLedgerFilter,
  isLedgerRangeInverted,
  spendBreakdown,
  toLedgerQuery,
  ledgerRowDetail,
  ledgerTypeChip,
  spendWindow,
} from './creditLedgerModel';

const row = (overrides: Partial<AdminLedgerRow>): AdminLedgerRow => ({
  id: 'tx',
  type: 'text_generation_usage',
  kind: 'usage',
  createdAt: '2026-10-27T00:00:00Z',
  credits: -10,
  ...overrides,
});

describe('creditLedgerModel', () => {
  it('offers All plus one filter per ledger kind', () => {
    expect(LEDGER_FILTER_OPTIONS.map(option => option.value)).toEqual(['all', ...ADMIN_LEDGER_KINDS]);
  });

  it('labels every kind, and an adjustment with an actor as Admin', () => {
    for (const kind of ADMIN_LEDGER_KINDS) {
      expect(ledgerTypeChip(row({ kind })).label).not.toBe('');
    }
    expect(ledgerTypeChip(row({ kind: 'subscription' }))).toEqual({ label: 'Renewal', tone: 'good' });
    expect(ledgerTypeChip(row({ kind: 'adjustment', actorId: 'a' })).label).toBe('Admin');
    expect(ledgerTypeChip(row({ kind: 'adjustment' })).label).toBe('Adjustment');
  });

  it('describes adjustments by note and admin, falling back to a readable reason', () => {
    expect(ledgerRowDetail(row({ kind: 'adjustment', note: 'Refund', actorName: 'Sam' }))).toBe('Refund · by Sam');
    expect(ledgerRowDetail(row({ kind: 'adjustment', reason: 'credit_expiry' }))).toBe('Credits expired');
    expect(ledgerRowDetail(row({ kind: 'adjustment', reason: 'some_new_reason' }))).toBe('Some new reason');
  });

  it('describes usage by description, key and tokens', () => {
    expect(
      ledgerRowDetail(
        row({ kind: 'api', description: 'Completion', apiKeyPrefix: 'b4m_ab12', inputTokens: 1000, outputTokens: 234 })
      )
    ).toBe('Completion · key b4m_ab12 · 1,234 tokens');
    expect(ledgerRowDetail(row({}))).toBe('');
  });

  it('slices the newest days of the series and formats UTC days', () => {
    const daily = Array.from({ length: 90 }, (_, index) => ({ date: `d${index}`, credits: index }));
    expect(spendWindow(daily, '7').map(point => point.credits)).toEqual([83, 84, 85, 86, 87, 88, 89]);
    expect(spendWindow(daily, '90')).toHaveLength(90);
    expect(formatSpendDay('2026-10-01')).toBe('Oct 1');
  });
});

describe('spendBreakdown', () => {
  const bucket = (key: string | null, last30d: number) => ({ key, last7d: 0, last30d, last90d: last30d });

  it('reads the chosen range, drops buckets without spend and sorts largest first', () => {
    expect(spendBreakdown([bucket('a', 5), bucket('b', 0), bucket('c', 9)], '30', 'model')).toEqual([
      { label: 'c', credits: 9 },
      { label: 'a', credits: 5 },
    ]);
    expect(spendBreakdown([bucket('a', 5)], '7', 'model')).toEqual([]);
  });

  it('labels missing keys and known sources', () => {
    expect(spendBreakdown([bucket(null, 1)], '30', 'model')).toEqual([{ label: 'Unknown model', credits: 1 }]);
    expect(spendBreakdown([bucket('cli', 2), bucket(null, 1)], '30', 'source')).toEqual([
      { label: 'CLI', credits: 2 },
      { label: 'Unclassified', credits: 1 },
    ]);
  });

  it('folds the long tail into one Other bar so the total is kept', () => {
    const buckets = Array.from({ length: SPEND_BREAKDOWN_MAX_BARS + 3 }, (_, i) => bucket(`m${i}`, 100 - i));
    const bars = spendBreakdown(buckets, '30', 'model');

    expect(bars).toHaveLength(SPEND_BREAKDOWN_MAX_BARS);
    expect(bars.at(-1)?.label).toBe('Other');
    const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
    expect(sum(bars.map(bar => bar.credits))).toBe(sum(buckets.map(b => b.last30d)));
  });
});

describe('ledger filter state', () => {
  it('sends only the set fields, with the model trimmed', () => {
    expect(toLedgerQuery(EMPTY_LEDGER_FILTER)).toEqual({});
    expect(
      toLedgerQuery({ kind: 'usage', model: '  m1 ', source: 'cli', from: '2026-01-01', to: '2026-01-31' })
    ).toEqual({ kind: 'usage', model: 'm1', source: 'cli', from: '2026-01-01', to: '2026-01-31' });
    expect(toLedgerQuery({ ...EMPTY_LEDGER_FILTER, model: '   ' })).toEqual({});
  });

  it('flags a reversed range and any set filter', () => {
    expect(isLedgerRangeInverted({ ...EMPTY_LEDGER_FILTER, from: '2026-02-01', to: '2026-01-01' })).toBe(true);
    expect(isLedgerRangeInverted({ ...EMPTY_LEDGER_FILTER, from: '2026-01-01', to: '2026-01-01' })).toBe(false);
    expect(isLedgerRangeInverted({ ...EMPTY_LEDGER_FILTER, from: '2026-02-01' })).toBe(false);
    expect(hasLedgerFilter(EMPTY_LEDGER_FILTER)).toBe(false);
    expect(hasLedgerFilter({ ...EMPTY_LEDGER_FILTER, to: '2026-01-01' })).toBe(true);
  });
});
