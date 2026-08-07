import { describe, it, expect } from 'vitest';
import { successorCostDelta, formatPerMTok, formatPctChange } from './successorCostDelta';

// Rates per MTok. grok-3-mini -> grok-4.5 is the case the cost-safety decision
// was argued from: 6.7x input, 12x output.
const RATES = {
  'grok-3-mini': { input: 0.3, output: 0.5 },
  'grok-4.5': { input: 2, output: 6 },
  'grok-4.5-cheap': { input: 0.1, output: 0.5 },
  'gpt-free': { input: 0, output: 0 },
};

describe('successorCostDelta', () => {
  it('reports both rates and the percentage for a more expensive successor', () => {
    const delta = successorCostDelta('grok-3-mini', 'grok-4.5', RATES);

    expect(delta.verdict).toBe('more-expensive');
    expect(delta.input).toEqual({ from: 0.3, to: 2, pctChange: expect.closeTo(566.67, 1) });
    expect(delta.output).toEqual({ from: 0.5, to: 6, pctChange: 1100 });
  });

  it('counts a successor cheaper on input but equal on output as cheaper-or-equal', () => {
    expect(successorCostDelta('grok-3-mini', 'grok-4.5-cheap', RATES).verdict).toBe('cheaper-or-equal');
  });

  it('is more-expensive when only one of the two rates rises', () => {
    const rates = { a: { input: 1, output: 1 }, b: { input: 0.5, output: 2 } };
    expect(successorCostDelta('a', 'b', rates).verdict).toBe('more-expensive');
  });

  // Unverifiable is not free: the automation's cost clause refuses the same case,
  // and a green delta here would contradict it.
  it('is unverifiable when either side has no rate in force', () => {
    expect(successorCostDelta('grok-3-mini', 'unpriced', RATES)).toEqual({ verdict: 'unverifiable' });
    expect(successorCostDelta('unpriced', 'grok-4.5', RATES)).toEqual({ verdict: 'unverifiable' });
  });

  it('omits pctChange when the current rate is 0, since the increase has no finite ratio', () => {
    const delta = successorCostDelta('gpt-free', 'grok-4.5', RATES);

    expect(delta.verdict).toBe('more-expensive');
    expect(delta.input).toEqual({ from: 0, to: 2 });
    expect(delta.output).toEqual({ from: 0, to: 6 });
  });

  it('treats free-to-free as no change rather than an unpriced hole', () => {
    const delta = successorCostDelta('gpt-free', 'gpt-free', RATES);

    expect(delta.verdict).toBe('cheaper-or-equal');
    expect(delta.input).toEqual({ from: 0, to: 0, pctChange: 0 });
  });
});

describe('formatPerMTok', () => {
  it('keeps three decimals under a dollar and two above, so neither end rounds away', () => {
    expect(formatPerMTok(0.075)).toBe('$0.075');
    expect(formatPerMTok(75)).toBe('$75.00');
    expect(formatPerMTok(0)).toBe('$0');
  });
});

describe('formatPctChange', () => {
  it('adds the multiple once the increase reaches 100 percent', () => {
    expect(formatPctChange(1100)).toBe('+1100% (12.0x)');
    expect(formatPctChange(566.67)).toBe('+567% (6.7x)');
    expect(formatPctChange(100)).toBe('+100% (2.0x)');
  });

  it('reports smaller moves as a bare percentage', () => {
    expect(formatPctChange(99)).toBe('+99%');
    expect(formatPctChange(-40)).toBe('-40%');
    expect(formatPctChange(2.5)).toBe('+2.5%');
    expect(formatPctChange(0)).toBe('no change');
  });

  it('names the unbounded case instead of printing Infinity', () => {
    expect(formatPctChange(undefined)).toBe('from $0');
  });
});
