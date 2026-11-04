import { describe, expect, it, vi } from 'vitest';
import { Types } from 'mongoose';
import type { CreditTransactionType } from '@bike4mind/common';

vi.mock('@bike4mind/database', () => ({
  CreditTransaction: {},
  creditTransactionRepository: {},
  Session: {},
}));
vi.mock('@bike4mind/database/auth', () => ({ userApiKeyRepository: {} }));

import { rollUpSpend, spendGroupToEntry, type SpendGroup, type SpendLedgerRow } from './userTimelineSpend';

let seq = 0;
const id = () => new Types.ObjectId((0x6700000000 + seq++).toString(16).padStart(24, '0'));

const row = (
  at: string,
  type: CreditTransactionType,
  credits: number,
  extra: Partial<SpendLedgerRow> = {}
): SpendLedgerRow => ({
  _id: id(),
  type,
  credits,
  createdAt: new Date(at),
  ...extra,
});

const noLookups = { notebookNames: new Map<string, string>(), apiKeyPrefixes: new Map<string, string>() };

describe('rollUpSpend', () => {
  it('groups usage by hour, notebook and model, and gives each group the balance after its newest charge', () => {
    const rows = [
      row('2026-11-01T10:50:00Z', 'text_generation_usage', 30, { model: 'opus', sessionId: 'n1' }),
      row('2026-11-01T10:40:00Z', 'image_generation_usage', 50, { model: 'img', sessionId: 'n1' }),
      row('2026-11-01T10:10:00Z', 'text_generation_usage', 20, { model: 'opus', sessionId: 'n1' }),
      row('2026-11-01T10:05:00Z', 'purchase', 1000),
      row('2026-11-01T09:30:00Z', 'text_generation_usage', 10, { model: 'opus', sessionId: 'n1' }),
    ];

    const groups = rollUpSpend(rows, { balanceAfterNewest: 900, truncated: false });

    expect(groups).toHaveLength(3);
    expect(groups[0]).toMatchObject({
      id: rows[0]._id.toHexString(),
      at: rows[0].createdAt,
      firstAt: rows[2].createdAt,
      credits: 50,
      calls: 2,
      model: 'opus',
      notebookId: 'n1',
      balanceAfter: 900,
      partial: false,
    });
    expect(groups[1]).toMatchObject({ transactionType: 'image_generation_usage', credits: 50, balanceAfter: 930 });
    // Walk back: 900 + 30 + 50 + 20 - 1000 (the purchase) = 0 after the 09:30 charge.
    expect(groups[2]).toMatchObject({ credits: 10, calls: 1, balanceAfter: 0 });
  });

  it('keeps API key and source apart', () => {
    const rows = [
      row('2026-11-01T10:50:00Z', 'completion_api_usage', 5, { apiKeyId: 'k1', source: 'api' }),
      row('2026-11-01T10:40:00Z', 'completion_api_usage', 5, { apiKeyId: 'k2', source: 'api' }),
      row('2026-11-01T10:30:00Z', 'completion_api_usage', 5, { source: 'cli' }),
    ];
    expect(rollUpSpend(rows, { truncated: false })).toHaveLength(3);
  });

  it('drops the oldest hour of a truncated read, since it may be missing rows', () => {
    const rows = [
      row('2026-11-01T11:10:00Z', 'text_generation_usage', 5),
      row('2026-11-01T10:10:00Z', 'text_generation_usage', 5),
    ];
    const groups = rollUpSpend(rows, { truncated: true });
    expect(groups.map(group => group.at)).toEqual([rows[0].createdAt]);
  });

  it('keeps a truncated read that is all one hour, marked partial', () => {
    const rows = [
      row('2026-11-01T10:20:00Z', 'text_generation_usage', 5),
      row('2026-11-01T10:10:00Z', 'text_generation_usage', 5),
    ];
    const groups = rollUpSpend(rows, { truncated: true });
    expect(groups).toEqual([expect.objectContaining({ calls: 2, partial: true })]);
  });

  it('ignores non-usage rows apart from the balance walk', () => {
    expect(rollUpSpend([row('2026-11-01T10:00:00Z', 'purchase', 100)], { truncated: false })).toEqual([]);
  });
});

const group = (overrides: Partial<SpendGroup> = {}): SpendGroup => ({
  id: 'a'.repeat(24),
  at: new Date('2026-11-01T10:30:00Z'),
  firstAt: new Date('2026-11-01T10:00:00Z'),
  credits: 2400.4,
  calls: 14,
  transactionType: 'text_generation_usage',
  model: 'opus',
  notebookId: 'b'.repeat(24),
  source: 'cli',
  apiKeyId: 'c'.repeat(24),
  balanceAfter: 1200,
  partial: false,
  ...overrides,
});

describe('spendGroupToEntry', () => {
  it('names the count, model and notebook, and puts source, key, span and balance in the detail', () => {
    const entry = spendGroupToEntry(group(), {
      notebookNames: new Map([['b'.repeat(24), 'Notebook X']]),
      apiKeyPrefixes: new Map([['c'.repeat(24), 'b4m_ab12']]),
    });
    expect(entry.summary).toBe('Spent 2,400 credits: 14 chat messages on opus in "Notebook X"');
    expect(entry.detail).toBe('CLI · key b4m_ab12 · over 30 min · balance after 1,200');
    expect(entry.alert).toBeUndefined();
    expect(entry.flags).toBeUndefined();
  });

  it('flags a negative balance', () => {
    const entry = spendGroupToEntry(group({ balanceAfter: -40 }), noLookups);
    expect(entry.flags).toEqual(['Negative balance']);
    expect(entry.alert).toBe(true);
  });

  it('marks a partial group as a lower bound, and uses singular nouns for one call', () => {
    expect(spendGroupToEntry(group({ partial: true }), noLookups).summary).toMatch(/^Spent 2,400\+ credits: 14\+ chat/);
    expect(
      spendGroupToEntry(
        group({ calls: 1, transactionType: 'image_generation_usage', model: undefined, notebookId: undefined }),
        noLookups
      ).summary
    ).toBe('Spent 2,400 credits: 1 image');
  });
});
