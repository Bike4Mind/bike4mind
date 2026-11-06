import { describe, it, expect } from 'vitest';
import { isCreditHolder } from './CreditHolderTypes';

describe('isCreditHolder', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a string', 'x'],
    ['a string lastCreditsPurchasedAt', { currentCredits: 5, lastCreditsPurchasedAt: '2026-01-01' }],
    ['a string currentCredits', { currentCredits: '5' }],
  ])('returns false for %s', (_label, value) => {
    expect(isCreditHolder(value)).toBe(false);
  });

  it.each([
    ['null lastCreditsPurchasedAt', { currentCredits: 5, lastCreditsPurchasedAt: null }],
    ['Date lastCreditsPurchasedAt', { currentCredits: 5, lastCreditsPurchasedAt: new Date() }],
    ['omitted lastCreditsPurchasedAt', { currentCredits: 5 }],
  ])('returns true for %s', (_label, value) => {
    expect(isCreditHolder(value)).toBe(true);
  });
});
