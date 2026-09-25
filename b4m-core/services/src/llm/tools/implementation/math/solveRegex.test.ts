import { describe, it, expect } from 'vitest';
import { matchSolveCall } from './index';
import {
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  seededCorpus,
} from '../../../../__tests__/utils/regexLinearity';

const OLD = /solve\s*\(\s*([^,=]+)\s*=\s*([^,)]+)\s*(?:,\s*([a-zA-Z]\w*))?\s*\)/;
// The linear-in-whitespace regex this scanner replaced; its captures are untrimmed like the scanner's.
const REGEX_FORM = /solve\s*\(([^,=]+)=([^,)]+)(?:,\s*([a-zA-Z]\w*)\s*)?\)/;

const trimmed = (m: ReadonlyArray<string | undefined> | null) => (m ? m.map(g => (g ?? '').trim()) : null);

describe('matchSolveCall', () => {
  const corpus = seededCorpus(2998, 8000, [
    'solve',
    'solve(',
    '(',
    ')',
    ' ',
    '\t',
    '=',
    ',',
    'x',
    '2*x',
    '1',
    'y',
    'a1',
  ]);

  it('captures exactly what the regex form did', () => {
    expect(corpus.filter(s => REGEX_FORM.test(s)).length).toBeGreaterThan(20);
    expect(
      corpus.filter(s => JSON.stringify(matchSolveCall(s)) !== JSON.stringify(s.match(REGEX_FORM)?.slice(1) ?? null))
    ).toEqual([]);
  });

  it('matches the old regex on every seeded input once captures are trimmed', () => {
    expect(
      corpus.filter(
        s => JSON.stringify(trimmed(matchSolveCall(s))) !== JSON.stringify(trimmed(s.match(OLD)?.slice(1) ?? null))
      )
    ).toEqual([]);
  });

  // Before: cubic on the first shape (over 3s at n=2000), quadratic on the rest.
  it.each([
    ['an unclosed call with trailing spaces', (n: number) => 'solve(a= b' + ' '.repeat(n), 1500],
    ['spaces before the equals sign', (n: number) => 'solve(a' + ' '.repeat(n) + '= b', 20000],
    ['repeated openers with no call', (n: number) => 'solve('.repeat(n), 16000],
    ['repeated unclosed calls', (n: number) => 'solve(a=b'.repeat(n), 16000],
    [
      'balanced repeated openers with a comma and no variable',
      (n: number) => 'solve('.repeat(n) + '=' + '1'.repeat(n) + ',' + ')'.repeat(n),
      16000,
    ],
  ])('stays linear on %s', (_label, build, small) => {
    const { baselineMs, ratio } = measureGrowth(matchSolveCall, build, small);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });
});
