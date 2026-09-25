import { describe, it, expect } from 'vitest';
import { SOLVE_CALL_REGEX } from './index';
import {
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '../../../../__tests__/utils/regexLinearity';

const OLD = /solve\s*\(\s*([^,=]+)\s*=\s*([^,)]+)\s*(?:,\s*([a-zA-Z]\w*))?\s*\)/;

describe('SOLVE_CALL_REGEX', () => {
  it('matches the old regex on every seeded input once captures are trimmed', () => {
    const corpus = seededCorpus(2998, 4000, ['solve', 'solve(', '(', ')', ' ', '\t', '=', ',', 'x', '2*x', '1', 'y']);
    expect(corpus.filter(s => SOLVE_CALL_REGEX.test(s)).length).toBeGreaterThan(20);
    expect(regexDivergences(OLD, SOLVE_CALL_REGEX, corpus)).toEqual([]);
  });

  // Before: cubic on the first shape (over 3s at n=2000), quadratic on the second.
  it.each([
    ['an unclosed call with trailing spaces', (n: number) => 'solve(a= b' + ' '.repeat(n), 1500],
    ['spaces before the equals sign', (n: number) => 'solve(a' + ' '.repeat(n) + '= b', 20000],
  ])('stays linear on %s', (_label, build, small) => {
    const { baselineMs, ratio } = measureGrowth(s => s.match(SOLVE_CALL_REGEX), build, small);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });
});
