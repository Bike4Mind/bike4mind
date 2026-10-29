import { describe, expect, it } from 'vitest';
import { ADMIN_LEDGER_KINDS, type AdminLedgerRow } from '@bike4mind/common';
import {
  LEDGER_FILTER_OPTIONS,
  formatSpendDay,
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
