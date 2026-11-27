import { describe, expect, it } from 'vitest';
import {
  MAX_CREDIT_AMOUNT,
  computeCreditAdjustment,
  creditAdjustmentPayload,
  formatCreditDelta,
  parseCreditAmount,
} from './creditAdjustment';

describe('parseCreditAmount', () => {
  it('accepts 0 and whole numbers up to the server bound', () => {
    expect(parseCreditAmount('0')).toBe(0);
    expect(parseCreditAmount(' 2500 ')).toBe(2500);
    expect(parseCreditAmount(String(MAX_CREDIT_AMOUNT))).toBe(MAX_CREDIT_AMOUNT);
  });

  it.each(['', '-1', '1.5', 'abc', '1e3', String(MAX_CREDIT_AMOUNT + 1)])('rejects %j', raw => {
    expect(parseCreditAmount(raw)).toBeNull();
  });
});

describe('computeCreditAdjustment', () => {
  it('sets an absolute balance, including 0', () => {
    expect(computeCreditAdjustment(12_450, 'set', 0)).toEqual({ before: 12_450, after: 0, delta: -12_450 });
    expect(computeCreditAdjustment(100, 'set', 400)).toEqual({ before: 100, after: 400, delta: 300 });
  });

  it('adds and subtracts', () => {
    expect(computeCreditAdjustment(100, 'add', 50).after).toBe(150);
    expect(computeCreditAdjustment(100, 'subtract', 40).after).toBe(60);
  });

  it('floors a deduction at 0', () => {
    expect(computeCreditAdjustment(100, 'subtract', 500)).toEqual({ before: 100, after: 0, delta: -100 });
  });

  it('never deepens a negative balance', () => {
    expect(computeCreditAdjustment(-20, 'subtract', 10)).toEqual({ before: -20, after: -20, delta: 0 });
  });
});

describe('creditAdjustmentPayload', () => {
  it('sends a set as an absolute balance and add/subtract as a signed delta', () => {
    expect(creditAdjustmentPayload('set', 0)).toEqual({ currentCredits: 0 });
    expect(creditAdjustmentPayload('add', 25)).toEqual({ creditDelta: 25 });
    expect(creditAdjustmentPayload('subtract', 25)).toEqual({ creditDelta: -25 });
  });
});

describe('formatCreditDelta', () => {
  it('signs and groups the delta', () => {
    expect(formatCreditDelta(2000)).toBe('+2,000');
    expect(formatCreditDelta(-412)).toBe('\u2212412');
    expect(formatCreditDelta(0)).toBe('No change');
  });
});
