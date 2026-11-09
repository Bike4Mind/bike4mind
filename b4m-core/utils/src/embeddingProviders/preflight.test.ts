import { describe, expect, it } from 'vitest';
import { sumReportedTokens } from './preflight';

describe('sumReportedTokens', () => {
  it('sums the counts when every response reported one', () => {
    expect(sumReportedTokens([3, 4, 5])).toBe(12);
  });

  it('is undefined when any response omitted its count, so a partial total is never billed', () => {
    expect(sumReportedTokens([3, undefined, 5])).toBeUndefined();
  });

  it('is undefined when no response reported a count', () => {
    expect(sumReportedTokens([undefined, undefined])).toBeUndefined();
    expect(sumReportedTokens([])).toBeUndefined();
  });
});
