import { describe, it, expect } from 'vitest';
import { DIAGNOSIS_BLOCK_REGEX, TOOL_BLOCK_REGEX } from './index';
import {
  FENCE_PIECES,
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '../__tests__/utils/regexLinearity';

describe.each([
  ['diagnosis', /```diagnosis\s*([\s\S]*?)```/, DIAGNOSIS_BLOCK_REGEX],
  ['tool', /```tool\s*([\s\S]*?)```/g, TOOL_BLOCK_REGEX],
] as const)('%s block regex', (tag, oldRe, newRe) => {
  it('matches the old regex on every seeded input once captures are trimmed', () => {
    const corpus = seededCorpus(2998, 3000, [...FENCE_PIECES, '```' + tag]);
    expect(corpus.filter(s => new RegExp(newRe).test(s)).length).toBeGreaterThan(300);
    expect(regexDivergences(oldRe, newRe, corpus)).toEqual([]);
  });

  // Quadratic before: about 200ms at n=64000, four times that when doubled.
  it('stays linear on an unclosed fence followed by whitespace', () => {
    const { baselineMs, ratio } = measureGrowth(
      s => s.match(new RegExp(newRe)),
      n => '```' + tag + '\n'.repeat(n) + 'x',
      64000
    );
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });
});
