import { describe, it, expect } from 'vitest';
import { parseTolerantJson } from './parseJson';
import {
  FENCE_PIECES,
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '../../../../__tests__/utils/regexLinearity';

const OLD_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;
const NEW_FENCE = /```(?:json)?([\s\S]*?)```/i;

describe('parseTolerantJson - code fence regex', () => {
  it('still parses a fenced object', () => {
    expect(parseTolerantJson('Plan:\n```JSON\n  {"a": 1}\n```')).toEqual({ a: 1 });
  });

  // The old single-sided prefix is quadratic rather than cubic, so it needs a long input to show:
  // about 200ms at n=64000 and four times that when doubled.
  it('stays linear on an unclosed fence followed by whitespace', () => {
    const { baselineMs, ratio } = measureGrowth(parseTolerantJson, n => '```json' + '\n'.repeat(n) + 'x', 64000);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });

  it('matches the old regex on every seeded input once captures are trimmed', () => {
    const corpus = seededCorpus(2998, 3000, FENCE_PIECES);
    expect(corpus.filter(s => NEW_FENCE.test(s)).length).toBeGreaterThan(300);
    expect(regexDivergences(OLD_FENCE, NEW_FENCE, corpus)).toEqual([]);
    expect(regexDivergences(OLD_FENCE, /```(?:json)?([\s\S]*)```/i, corpus).length).toBeGreaterThan(0);
  });
});
