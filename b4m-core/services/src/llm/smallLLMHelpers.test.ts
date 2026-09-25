import { describe, it, expect } from 'vitest';
import { extractJSON } from './smallLLMHelpers';
import {
  FENCE_PIECES,
  GROWTH_RATIO_CEILING,
  SMALL_INPUT_MS_CEILING,
  measureGrowth,
  regexDivergences,
  seededCorpus,
} from '../__tests__/utils/regexLinearity';

const OLD_FENCE = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/;
const NEW_FENCE = /```(?:json)?([\s\S]*?)```/;

describe('extractJSON - code fence regex', () => {
  it('still unwraps a fenced JSON object', () => {
    expect(extractJSON('Here:\n```json\n  {"a": 1}\n\n```')).toBe('{"a": 1}');
  });

  // extractJSON trims its input, so the 'x' tail is what keeps the whitespace run alive. The old
  // fence regex is cubic here: about 2.6s per call on the first shape and 1s on the second.
  it.each([
    ['newlines', (n: number) => '```json\n' + '\n'.repeat(n) + 'x', 1200],
    ['space-newline pairs', (n: number) => '```json' + ' \n'.repeat(n) + 'x', 600],
  ])('stays linear on an unclosed fence followed by %s', (_label, build, small) => {
    const { baselineMs, ratio } = measureGrowth(extractJSON, build, small);
    expect(baselineMs).toBeLessThan(SMALL_INPUT_MS_CEILING);
    expect(ratio).toBeLessThan(GROWTH_RATIO_CEILING);
  });

  it('matches the old regex on every seeded input once captures are trimmed', () => {
    const corpus = seededCorpus(2998, 3000, FENCE_PIECES);
    expect(corpus.filter(s => NEW_FENCE.test(s)).length).toBeGreaterThan(500);
    expect(regexDivergences(OLD_FENCE, NEW_FENCE, corpus)).toEqual([]);
    // Control: a greedy body does diverge, so this differential can fail.
    expect(regexDivergences(OLD_FENCE, /```(?:json)?([\s\S]*)```/, corpus).length).toBeGreaterThan(0);
  });
});
