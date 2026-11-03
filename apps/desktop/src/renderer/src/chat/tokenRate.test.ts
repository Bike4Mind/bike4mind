import { describe, expect, it } from 'vitest';
import { describeTokenRate, formatTokenRate, parseStoredTokenRate } from './tokenRate';

describe('parseStoredTokenRate', () => {
  it('defaults on and turns off only for a stored 0', () => {
    expect(parseStoredTokenRate(null)).toBe(true);
    expect(parseStoredTokenRate('1')).toBe(true);
    expect(parseStoredTokenRate('0')).toBe(false);
  });
});

describe('formatTokenRate', () => {
  it('shows one decimal under 100 tok/s and whole numbers above', () => {
    expect(formatTokenRate({ evalTokens: 478, evalMs: 20_000 })).toBe('23.9 tok/s');
    expect(formatTokenRate({ evalTokens: 1500, evalMs: 10_000 })).toBe('150 tok/s');
  });

  it('marks an estimate with a tilde', () => {
    expect(formatTokenRate({ evalTokens: 40, evalMs: 2000, estimated: true })).toBe('~20.0 tok/s');
  });

  it.each([undefined, null, { evalTokens: 0, evalMs: 100 }, { evalTokens: 10, evalMs: 0 }])(
    'shows nothing without a measurement: %j',
    rate => {
      expect(formatTokenRate(rate)).toBeNull();
    }
  );
});

describe('describeTokenRate', () => {
  it('adds prompt, load and draft lines only where reported', () => {
    expect(
      describeTokenRate({
        evalTokens: 478,
        evalMs: 20_000,
        promptTokens: 1200,
        promptMs: 1500,
        loadMs: 2300,
        draftTokens: 245,
        draftAccepted: 120,
      })
    ).toBe(
      [
        'Generation: 23.9 tok/s (478 tokens in 20.0s)',
        'Prompt: 800 tok/s (1.2k tokens in 1.5s)',
        'Load: 2.3s',
        'Draft acceptance: 49% (120 of 245)',
      ].join('\n')
    );
    expect(describeTokenRate({ evalTokens: 10, evalMs: 400 })).toBe('Generation: 25.0 tok/s (10 tokens in 400ms)');
  });

  it('says how much of the output was timed when some rounds were not', () => {
    expect(describeTokenRate({ evalTokens: 40, evalMs: 2000 }, 100)).toBe(
      'Generation: 20.0 tok/s (timed 40 of 100 output tokens in 2.0s)'
    );
    expect(describeTokenRate({ evalTokens: 40, evalMs: 2000 }, 40)).toBe(
      'Generation: 20.0 tok/s (40 tokens in 2.0s)'
    );
  });

  it('says an estimate was timed by the app', () => {
    expect(describeTokenRate({ evalTokens: 40, evalMs: 2000, estimated: true })).toBe(
      'Generation: ~20.0 tok/s (40 tokens in 2.0s)\nEstimated from stream timing; the server reported no timings'
    );
  });

  it('is null with nothing measured', () => {
    expect(describeTokenRate(undefined)).toBeNull();
  });
});
