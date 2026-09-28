import { describe, it, expect } from 'vitest';
import { FENCED_JSON_REGEX } from './processDiscoveredLinks';
import {
  FENCE_PIECES,
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '../__tests__/utils/regexLinearity';

const OLD_FENCE = /```(?:json)?\s*([\s\S]*?)\s*```/;

describe('FENCED_JSON_REGEX', () => {
  // About 2s per call at n=2000 with the old regex.
  it('stays linear on an unclosed fence followed by whitespace', () => {
    const { baselineMs, ratio } = measureGrowth(
      s => FENCED_JSON_REGEX.exec(s),
      n => '```json' + '\n'.repeat(n) + 'x',
      2000
    );
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });

  it('matches the old regex on every seeded input once captures are trimmed', () => {
    const corpus = seededCorpus(2998, 3000, FENCE_PIECES);
    expect(corpus.filter(s => FENCED_JSON_REGEX.test(s)).length).toBeGreaterThan(300);
    expect(regexDivergences(OLD_FENCE, FENCED_JSON_REGEX, corpus)).toEqual([]);
    expect(regexDivergences(OLD_FENCE, /```(?:json)?([\s\S]*)```/, corpus).length).toBeGreaterThan(0);
  });

  // A whitespace-only body now captures the whitespace instead of '', so it passes the caller's
  // empty-capture guard, but JSON.parse of the trimmed capture throws into the same outer error.
  it('leaves a whitespace-only fence unparseable', () => {
    const match = '```json   \n ```'.match(FENCED_JSON_REGEX);
    expect(match?.[1]).toBe('   \n ');
    expect(() => JSON.parse(match![1].trim())).toThrow();
  });
});
