import { describe, it, expect } from 'vitest';
import { formatAnswerCost, formatCreditBalance } from './formatCredits';

describe('formatCreditBalance', () => {
  it('labels the number and rounds fractional balances down', () => {
    expect(formatCreditBalance(9982.6)).toBe('9,982 credits');
    expect(formatCreditBalance(1)).toBe('1 credit');
    expect(formatCreditBalance(0)).toBe('0 credits');
    expect(formatCreditBalance(-12)).toBe('0 credits');
  });

  it('keeps every digit when compact below 100,000, so a small spend stays visible', () => {
    expect(formatCreditBalance(9_903, true)).toBe('9,903 credits');
    expect(formatCreditBalance(12_400, true)).toBe('12,400 credits');
    expect(formatCreditBalance(99_999.9, true)).toBe('99,999 credits');
    expect(formatCreditBalance(950, true)).toBe('950 credits');
  });

  it('abbreviates when compact from 100,000 up', () => {
    expect(formatCreditBalance(100_000, true)).toBe('100K credits');
    expect(formatCreditBalance(124_500, true)).toBe('124.5K credits');
    expect(formatCreditBalance(2_300_000, true)).toBe('2.3M credits');
  });
});

describe('formatAnswerCost', () => {
  it('rounds to whole credits with a label', () => {
    expect(formatAnswerCost(15)).toBe('15 credits');
    expect(formatAnswerCost(14.6)).toBe('15 credits');
    expect(formatAnswerCost(1)).toBe('1 credit');
    expect(formatAnswerCost(1234)).toBe('1,234 credits');
  });

  it('never shows a paid answer as free', () => {
    expect(formatAnswerCost(0.04)).toBe('<1 credit');
    expect(formatAnswerCost(0)).toBe('0 credits');
  });
});
