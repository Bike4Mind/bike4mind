import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  answerCostUnit,
  formatAnswerCost,
  formatAnswerCostAmount,
  formatCreditAmount,
  formatCreditBalance,
  purchaseCreditsAriaLabel,
} from './formatCredits';

describe('purchaseCreditsAriaLabel', () => {
  it('names the pack by its grouped credit count and dollar price', () => {
    expect(purchaseCreditsAriaLabel(50_000, 30)).toBe('Purchase 50,000 credits for $30');
  });
});

describe('formatCreditAmount', () => {
  afterEach(() => vi.restoreAllMocks());

  it('groups with en-US separators even when the browser locale would not', () => {
    // Stand-in for an es-ES browser: a bare toLocaleString() would give "50.000".
    const native = Number.prototype.toLocaleString;
    vi.spyOn(Number.prototype, 'toLocaleString').mockImplementation(function (this: number, locales, options) {
      return native.call(this, locales ?? 'es-ES', options);
    });

    expect(formatCreditAmount(50_000)).toBe('50,000');
    expect(formatCreditBalance(9_951)).toBe('9,951 credits');
  });
});

describe('formatCreditBalance', () => {
  it('labels the number and rounds fractional balances down', () => {
    expect(formatCreditBalance(9982.6)).toBe('9,982 credits');
    expect(formatCreditBalance(1)).toBe('1 credit');
    expect(formatCreditBalance(0)).toBe('0 credits');
    expect(formatCreditBalance(-12)).toBe('0 credits');
  });
});

describe('formatAnswerCostAmount', () => {
  it('is the bare number, with "<1" for a fractional cost', () => {
    expect(formatAnswerCostAmount(1234.4)).toBe('1,234');
    expect(formatAnswerCostAmount(0.04)).toBe('<1');
    expect(formatAnswerCostAmount(0)).toBe('0');
    expect(formatAnswerCostAmount(-3)).toBe('0');
  });

  it('pairs with a singular unit for "<1" and 1', () => {
    expect(answerCostUnit(0.4)).toBe('credit');
    expect(answerCostUnit(1.2)).toBe('credit');
    expect(answerCostUnit(2)).toBe('credits');
    expect(answerCostUnit(0)).toBe('credits');
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
