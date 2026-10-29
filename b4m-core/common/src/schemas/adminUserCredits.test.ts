import { describe, expect, it } from 'vitest';
import {
  ADMIN_LEDGER_KINDS,
  CREDIT_TRANSACTION_KIND,
  adminLedgerFilterSchema,
  adminLedgerQuerySchema,
  isContiguousLedgerFilter,
  signedCredits,
  transactionTypesForKind,
} from './adminUserCredits';
import {
  CREDIT_ADD_TRANSACTION_TYPES,
  CREDIT_DEDUCT_TRANSACTION_TYPES,
  type CreditTransactionType,
} from '../types/entities/CreditTransactionTypes';

const classifiedTypes = Object.keys(CREDIT_TRANSACTION_KIND) as CreditTransactionType[];

describe('CREDIT_TRANSACTION_KIND', () => {
  it('classifies every add and deduct transaction type', () => {
    const known = [...CREDIT_ADD_TRANSACTION_TYPES, ...CREDIT_DEDUCT_TRANSACTION_TYPES];
    expect([...classifiedTypes].sort()).toEqual([...new Set(known)].sort());
  });

  it('only maps to declared kinds', () => {
    for (const kind of Object.values(CREDIT_TRANSACTION_KIND)) {
      expect(ADMIN_LEDGER_KINDS).toContain(kind);
    }
  });

  it('leaves no declared kind without a transaction type', () => {
    for (const kind of ADMIN_LEDGER_KINDS) {
      expect(transactionTypesForKind(kind).length).toBeGreaterThan(0);
    }
  });
});

describe('transactionTypesForKind', () => {
  it('returns the types of a multi-type kind', () => {
    expect(transactionTypesForKind('adjustment').sort()).toEqual(['generic_add', 'generic_deduct']);
    expect(transactionTypesForKind('api').sort()).toEqual(['completion_api_usage', 'decision_usage']);
  });

  it('returns a single type for a one-type kind', () => {
    expect(transactionTypesForKind('purchase')).toEqual(['purchase']);
    expect(transactionTypesForKind('subscription')).toEqual(['subscription']);
  });

  it('partitions all types exactly once across kinds', () => {
    const all = ADMIN_LEDGER_KINDS.flatMap(kind => transactionTypesForKind(kind));
    expect(all.sort()).toEqual([...classifiedTypes].sort());
  });
});

describe('signedCredits', () => {
  it('is positive for add types regardless of stored sign', () => {
    expect(signedCredits('purchase', 100)).toBe(100);
    expect(signedCredits('generic_add', -100)).toBe(100);
    expect(signedCredits('received_credit', 5)).toBe(5);
  });

  it('is negative for deduct types regardless of stored sign', () => {
    expect(signedCredits('text_generation_usage', 12)).toBe(-12);
    expect(signedCredits('generic_deduct', -7)).toBe(-7);
    expect(signedCredits('transfer_credit', 3)).toBe(-3);
  });

  it('never returns negative zero for a zero amount on an add type', () => {
    expect(Object.is(signedCredits('generic_add', 0), 0)).toBe(true);
  });
});

describe('ledger filter schemas', () => {
  it('accepts model, source and an inclusive single-day range', () => {
    expect(
      adminLedgerQuerySchema.parse({ model: ' m1 ', source: 'cli', from: '2026-01-01', to: '2026-01-01', limit: '5' })
    ).toEqual({ model: 'm1', source: 'cli', from: '2026-01-01', to: '2026-01-01', limit: 5 });
  });

  it('rejects an unknown source, a non-date and a start after the end, on both schemas', () => {
    for (const schema of [adminLedgerFilterSchema, adminLedgerQuerySchema]) {
      expect(schema.safeParse({ source: 'fax' }).success).toBe(false);
      expect(schema.safeParse({ from: '2026-02-30' }).success).toBe(false);
      expect(schema.safeParse({ from: '2026-02-02', to: '2026-02-01' }).success).toBe(false);
    }
  });

  it('treats only a date range as keeping the ledger contiguous', () => {
    expect(isContiguousLedgerFilter({})).toBe(true);
    expect(isContiguousLedgerFilter({ from: '2026-01-01', to: '2026-01-31' })).toBe(true);
    expect(isContiguousLedgerFilter({ kind: 'usage' })).toBe(false);
    expect(isContiguousLedgerFilter({ model: 'm1' })).toBe(false);
    expect(isContiguousLedgerFilter({ source: 'web' })).toBe(false);
  });
});
