import { describe, it, expect } from 'vitest';
import {
  GenericCreditDeductTransaction,
  GenericDeductReasons,
  isGenericDeductReason,
  listGenericDeductReasons,
  registerGenericDeductReason,
} from './CreditTransactionTypes';
import { CreditHolderType } from './CreditHolderTypes';

const deduct = (reason: unknown) => ({
  type: 'generic_deduct' as const,
  ownerId: 'user-1',
  ownerType: CreditHolderType.User,
  credits: -10,
  reason,
  createdAt: new Date(),
  updatedAt: new Date(),
});

describe('generic deduct reason registry', () => {
  it('accepts every built-in reason', () => {
    for (const reason of GenericDeductReasons) {
      expect(isGenericDeductReason(reason)).toBe(true);
      expect(GenericCreditDeductTransaction.safeParse(deduct(reason)).success).toBe(true);
    }
    expect(listGenericDeductReasons()).toEqual(expect.arrayContaining([...GenericDeductReasons]));
  });

  it('keeps reason optional', () => {
    const { reason: _omitted, ...row } = deduct(undefined);
    expect(GenericCreditDeductTransaction.safeParse(row).success).toBe(true);
    expect(GenericCreditDeductTransaction.safeParse(deduct(undefined)).success).toBe(true);
  });

  it('rejects an unknown reason until it is registered, then accepts it', () => {
    const reason = 'registry_test_late_reason';
    expect(isGenericDeductReason(reason)).toBe(false);
    expect(GenericCreditDeductTransaction.safeParse(deduct(reason)).success).toBe(false);

    registerGenericDeductReason(reason);

    expect(isGenericDeductReason(reason)).toBe(true);
    expect(GenericCreditDeductTransaction.safeParse(deduct(reason)).success).toBe(true);
    expect(listGenericDeductReasons()).toContain(reason);
  });

  it('is idempotent, including for a built-in reason', () => {
    const before = listGenericDeductReasons().length;
    registerGenericDeductReason(GenericDeductReasons[0]);
    registerGenericDeductReason('registry_test_twice');
    registerGenericDeductReason('registry_test_twice');
    expect(listGenericDeductReasons()).toHaveLength(before + 1);
  });

  it.each([
    ['empty', ''],
    ['whitespace', '  '],
    ['uppercase', 'Registry_Test'],
    ['leading digit', '1_reason'],
    ['hyphen', 'registry-test'],
    ['padded', ' registry_test '],
  ])('refuses to register a malformed reason (%s)', (_label, reason) => {
    expect(() => registerGenericDeductReason(reason)).toThrow(/Invalid generic deduct reason/);
    expect(isGenericDeductReason(reason)).toBe(false);
  });

  it.each([
    ['null', null],
    ['number', 42],
    ['object', {}],
  ])('refuses to register a non-string (%s)', (_label, reason) => {
    expect(() => registerGenericDeductReason(reason as unknown as string)).toThrow(/Invalid generic deduct reason/);
  });

  it.each([
    ['null', null],
    ['number', 7],
    ['empty', ''],
    ['whitespace', '  '],
    ['uppercase built-in', GenericDeductReasons[0].toUpperCase()],
  ])('rejects a %s reason on parse', (_label, reason) => {
    expect(GenericCreditDeductTransaction.safeParse(deduct(reason)).success).toBe(false);
  });

  it('shares one registry across module copies through globalThis', () => {
    const shared = (globalThis as unknown as Record<symbol, Set<string>>)[
      Symbol.for('b4m.credit.genericDeductReasons')
    ];
    expect(shared).toBeInstanceOf(Set);

    // A second copy of the module would find this same set; simulate it writing first.
    shared.add('registry_test_other_copy');
    expect(isGenericDeductReason('registry_test_other_copy')).toBe(true);
  });
});
